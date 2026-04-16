const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - allow all origins (will also configure in Azure App Service)
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/media', require('./routes/media'));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        cosmos: process.env.COSMOS_CONNECTION_STRING ? 'configured' : 'missing',
        storage: process.env.AZURE_STORAGE_CONNECTION_STRING ? 'configured' : 'missing'
    });
});

// Root endpoint - API documentation
app.get('/', (req, res) => {
    res.json({
        name: 'MediaHub API',
        version: '1.0.0',
        description: 'Cloud-Native Multimedia Sharing Platform',
        endpoints: {
            'POST /api/media/upload': 'Upload a media file with metadata',
            'GET /api/media': 'List all media (optional ?mediaType=image|video)',
            'GET /api/media/:id': 'Get single media item by ID',
            'PUT /api/media/:id': 'Update media metadata',
            'DELETE /api/media/:id': 'Delete media and its blob'
        }
    });
});

app.listen(PORT, () => {
    console.log(`MediaHub API running on port ${PORT}`);
});
