const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
require('dotenv').config();

// ── Cosmos DB ──
const cosmosClient = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const database = cosmosClient.database('mediahub-db');
const mediaContainer = database.container('MediaItems');

// ── Azure Blob Storage ──
let blobServiceClient = null;
let mediaContainerClient = null;

if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    blobServiceClient = BlobServiceClient.fromConnectionString(
        process.env.AZURE_STORAGE_CONNECTION_STRING
    );
    mediaContainerClient = blobServiceClient.getContainerClient('media');
}

module.exports = {
    mediaContainer,
    blobServiceClient,
    mediaContainerClient
};
