const express = require('express');
const router = express.Router();
const { mediaContainer, mediaContainerClient, blobServiceClient } = require('../config/azure');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { BlobSASPermissions, generateBlobSASQueryParameters } = require('@azure/storage-blob');

const upload = multer({ storage: multer.memoryStorage() });

// ── Helper: Generate a time-limited SAS URL for viewing a blob ──
async function generateSasUrl(blobName) {
    if (!blobServiceClient) return null;

    try {
        const containerClient = blobServiceClient.getContainerClient('media');
        const blobClient = containerClient.getBlockBlobClient(blobName);

        const exists = await blobClient.exists();
        if (!exists) {
            console.log('Blob does not exist:', blobName);
            return null;
        }

        const startsOn = new Date();
        const expiresOn = new Date(startsOn);
        expiresOn.setHours(expiresOn.getHours() + 1);

        const sasToken = generateBlobSASQueryParameters({
            containerName: 'media',
            blobName: blobName,
            permissions: BlobSASPermissions.parse('r'),
            startsOn,
            expiresOn
        }, blobServiceClient.credential).toString();

        return `${blobClient.url}?${sasToken}`;
    } catch (error) {
        console.error('SAS generation error:', error.message);
        return null;
    }
}

// ── POST /api/media/upload — Upload file with metadata ──
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!mediaContainerClient) {
            return res.status(500).json({ error: 'Storage not configured' });
        }

        const { title, description, tags, mediaType } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        console.log('Uploading:', file.originalname, '| Size:', file.size);

        // Upload blob
        const blobName = `${uuidv4()}-${Date.now()}-${file.originalname}`;
        const blockBlobClient = mediaContainerClient.getBlockBlobClient(blobName);

        await blockBlobClient.uploadData(file.buffer, {
            blobHTTPHeaders: { blobContentType: file.mimetype }
        });

        console.log('Blob uploaded successfully');

        // Generate SAS URL for viewing
        const blobUrl = await generateSasUrl(blobName);

        // Store metadata in Cosmos DB
        const mediaItem = {
            id: uuidv4(),
            title,
            description: description || '',
            tags: tags ? tags.split(',').map(t => t.trim()) : [],
            mediaType,
            blobName,
            blobUrl: blobUrl || `https://${process.env.STORAGE_ACCOUNT_NAME}.blob.core.windows.net/media/${blobName}`,
            sizeBytes: file.size,
            mimeType: file.mimetype,
            createdAt: new Date().toISOString()
        };

        const { resource } = await mediaContainer.items.create(mediaItem);
        console.log('Metadata saved to Cosmos DB, ID:', resource.id);
        res.status(201).json(resource);

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload file: ' + error.message });
    }
});

// ── GET /api/media — List all media (optional ?mediaType filter) ──
router.get('/', async (req, res) => {
    try {
        const { mediaType } = req.query;
        let query = 'SELECT * FROM c ORDER BY c.createdAt DESC';
        let parameters = [];

        if (mediaType) {
            query = 'SELECT * FROM c WHERE c.mediaType = @mediaType ORDER BY c.createdAt DESC';
            parameters = [{ name: '@mediaType', value: mediaType }];
        }

        const { resources } = await mediaContainer.items
            .query({ query, parameters })
            .fetchAll();

        // Refresh SAS URLs for each item
        const itemsWithUrls = await Promise.all(
            resources.map(async (item) => {
                if (item.blobName) {
                    const url = await generateSasUrl(item.blobName);
                    if (url) return { ...item, blobUrl: url };
                }
                return item;
            })
        );

        res.json(itemsWithUrls);
    } catch (error) {
        console.error('List error:', error);
        res.status(500).json({ error: 'Failed to list media' });
    }
});

// ── GET /api/media/:id — Get single media by ID ──
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const query = 'SELECT * FROM c WHERE c.id = @id';
        const parameters = [{ name: '@id', value: id }];

        const { resources } = await mediaContainer.items
            .query({ query, parameters })
            .fetchAll();

        if (!resources || resources.length === 0) {
            return res.status(404).json({ error: 'Media not found' });
        }

        const resource = resources[0];

        // Generate fresh SAS URL
        if (resource.blobName && blobServiceClient) {
            const freshUrl = await generateSasUrl(resource.blobName);
            if (freshUrl) resource.blobUrl = freshUrl;
        }

        res.json(resource);
    } catch (error) {
        console.error('Get error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── PUT /api/media/:id — Update media metadata ──
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, tags } = req.body;

        // Find item
        const query = 'SELECT * FROM c WHERE c.id = @id';
        const parameters = [{ name: '@id', value: id }];
        const { resources } = await mediaContainer.items
            .query({ query, parameters })
            .fetchAll();

        if (!resources || resources.length === 0) {
            return res.status(404).json({ error: 'Media not found' });
        }

        const existing = resources[0];

        const updated = {
            ...existing,
            title: title !== undefined ? title : existing.title,
            description: description !== undefined ? description : existing.description,
            tags: tags !== undefined ? tags : existing.tags,
            updatedAt: new Date().toISOString()
        };

        const { resource } = await mediaContainer
            .item(existing.id, existing.mediaType)
            .replace(updated);

        console.log('Updated media:', id);
        res.json(resource);
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({ error: 'Failed to update media' });
    }
});

// ── DELETE /api/media/:id — Delete media and its blob ──
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Find item
        const query = 'SELECT * FROM c WHERE c.id = @id';
        const parameters = [{ name: '@id', value: id }];
        const { resources } = await mediaContainer.items
            .query({ query, parameters })
            .fetchAll();

        if (!resources || resources.length === 0) {
            return res.status(404).json({ error: 'Media not found' });
        }

        const resource = resources[0];

        // Delete blob from storage
        if (resource.blobName && mediaContainerClient) {
            try {
                const blockBlobClient = mediaContainerClient.getBlockBlobClient(resource.blobName);
                await blockBlobClient.deleteIfExists();
                console.log('Deleted blob:', resource.blobName);
            } catch (blobError) {
                console.error('Blob delete error:', blobError.message);
            }
        }

        // Delete metadata from Cosmos DB
        await mediaContainer.item(resource.id, resource.mediaType).delete();
        console.log('Deleted metadata for:', id);
        res.status(204).send();
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete media: ' + error.message });
    }
});

module.exports = router;
