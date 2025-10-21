const express = require('express');
const ftp = require('ftp');
const NodeCache = require('node-cache');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const FTP_HOST = 'ftp.bom.gov.au';
const FTP_PATH = '/anon/gen/radar/';

// Memory cache for metadata (1 hour TTL)
const metaCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Disk cache for images (longer TTL)
const DISK_CACHE_TTL = 3600 * 24; // 24 hours

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

// Ensure cache directory exists
(async () => {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    logger.info(`Cache directory ready: ${CACHE_DIR}`);
  } catch (error) {
    logger.error('Failed to create cache directory:', error);
  }
})();

// Radar configuration with resolution mappings
const RADAR_CONFIG = {
  resolutions: {
    64: { suffix: '', folder: 'IDR' },
    128: { suffix: '', folder: 'IDR' },
    256: { suffix: '', folder: 'IDR' },
    512: { suffix: '', folder: 'IDR' }
  }
};

/**
 * Connect to BoM FTP server
 */
function connectFTP() {
  return new Promise((resolve, reject) => {
    const client = new ftp();
    
    client.on('ready', () => {
      resolve(client);
    });
    
    client.on('error', (err) => {
      reject(err);
    });
    
    client.connect({
      host: FTP_HOST,
      connTimeout: 30000,
      pasvTimeout: 30000,
      keepalive: 30000
    });
  });
}

/**
 * Download file from FTP
 */
async function downloadFromFTP(radarId, timestamp, resolution) {
  const client = await connectFTP();
  
  return new Promise((resolve, reject) => {
    // Construct filename based on radar ID and timestamp
    // Format: IDRxxx.T.yyyyMMddHHmm.png
    const filename = `${radarId}.T.${timestamp}.png`;
    const remotePath = path.join(FTP_PATH, filename);
    
    logger.info(`Downloading: ${remotePath}`);
    
    const chunks = [];
    
    client.get(remotePath, (err, stream) => {
      if (err) {
        client.end();
        reject(err);
        return;
      }
      
      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      stream.on('end', () => {
        client.end();
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
      
      stream.on('error', (err) => {
        client.end();
        reject(err);
      });
    });
  });
}

/**
 * Get cached image or download from FTP
 */
async function getRadarImage(radarId, timestamp, resolution) {
  const cacheKey = `${radarId}_${timestamp}_${resolution}`;
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.png`);
  
  // Check if file exists in cache and is not expired
  try {
    const stats = await fs.stat(cachePath);
    const age = (Date.now() - stats.mtimeMs) / 1000;
    
    if (age < DISK_CACHE_TTL) {
      logger.info(`Cache hit: ${cacheKey}`);
      return await fs.readFile(cachePath);
    } else {
      logger.info(`Cache expired: ${cacheKey}`);
      await fs.unlink(cachePath);
    }
  } catch (error) {
    // File doesn't exist, continue to download
  }
  
  // Download from FTP
  try {
    logger.info(`Downloading radar image: ${cacheKey}`);
    const buffer = await downloadFromFTP(radarId, timestamp, resolution);
    
    // Save to cache
    await fs.writeFile(cachePath, buffer);
    logger.info(`Cached: ${cacheKey}`);
    
    return buffer;
  } catch (error) {
    logger.error(`Failed to download ${cacheKey}:`, error.message);
    throw error;
  }
}

/**
 * List available timestamps for a radar
 */
async function listAvailableTimestamps(radarId) {
  const cacheKey = `timestamps_${radarId}`;
  const cached = metaCache.get(cacheKey);
  
  if (cached) {
    return cached;
  }
  
  const client = await connectFTP();
  
  return new Promise((resolve, reject) => {
    client.list(FTP_PATH, (err, list) => {
      client.end();
      
      if (err) {
        reject(err);
        return;
      }
      
      // Filter files matching the radar ID pattern
      const pattern = new RegExp(`^${radarId}\\.T\\.(\\d{12})\\.png$`);
      const timestamps = list
        .filter(item => item.type === '-' && pattern.test(item.name))
        .map(item => {
          const match = item.name.match(pattern);
          return match ? match[1] : null;
        })
        .filter(Boolean)
        .sort()
        .reverse(); // Most recent first
      
      // Cache for 5 minutes
      metaCache.set(cacheKey, timestamps, 300);
      
      resolve(timestamps);
    });
  });
}

/**
 * Find closest radar to given coordinates
 */
function findClosestRadar(lat, lon, radarData) {
  let closestRadar = null;
  let minDistance = Infinity;
  
  for (const [id, radar] of Object.entries(radarData)) {
    // Calculate distance using Haversine formula
    const R = 6371; // Earth's radius in km
    const dLat = (radar.geometry.coordinates[1] - lat) * Math.PI / 180;
    const dLon = (radar.geometry.coordinates[0] - lon) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat * Math.PI / 180) * Math.cos(radar.geometry.coordinates[1] * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    if (distance < minDistance) {
      minDistance = distance;
      closestRadar = {
        id: radar.properties.id,
        name: radar.properties.name,
        distance: distance
      };
    }
  }
  
  return closestRadar;
}

// API Routes

/**
 * GET /api/radar/:radarId/:timestamp/:resolution
 * Get radar image
 */
app.get('/api/radar/:radarId/:timestamp/:resolution', async (req, res) => {
  try {
    const { radarId, timestamp, resolution } = req.params;
    
    // Validate parameters
    if (!radarId.match(/^IDR\d{2,4}$/)) {
      return res.status(400).json({ error: 'Invalid radar ID' });
    }
    
    if (!timestamp.match(/^\d{12}$/)) {
      return res.status(400).json({ error: 'Invalid timestamp format' });
    }
    
    const resNum = parseInt(resolution);
    if (![64, 128, 256, 512].includes(resNum)) {
      return res.status(400).json({ error: 'Invalid resolution' });
    }
    
    const imageBuffer = await getRadarImage(radarId, timestamp, resNum);
    
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600',
      'ETag': `${radarId}-${timestamp}-${resolution}`
    });
    
    res.send(imageBuffer);
  } catch (error) {
    logger.error('Error serving radar image:', error);
    
    if (error.code === 550) {
      res.status(404).json({ error: 'Radar image not found' });
    } else {
      res.status(500).json({ error: 'Failed to retrieve radar image' });
    }
  }
});

/**
 * GET /api/timestamps/:radarId
 * Get available timestamps for a radar
 */
app.get('/api/timestamps/:radarId', async (req, res) => {
  try {
    const { radarId } = req.params;
    
    if (!radarId.match(/^IDR\d{2,4}$/)) {
      return res.status(400).json({ error: 'Invalid radar ID' });
    }
    
    const timestamps = await listAvailableTimestamps(radarId);
    
    res.json({
      radarId,
      timestamps,
      count: timestamps.length
    });
  } catch (error) {
    logger.error('Error listing timestamps:', error);
    res.status(500).json({ error: 'Failed to list timestamps' });
  }
});

/**
 * GET /api/radars
 * Get all radar locations
 */
app.get('/api/radars', async (req, res) => {
  try {
    const radarsPath = path.join(__dirname, 'radars.json');
    const data = await fs.readFile(radarsPath, 'utf8');
    const radars = JSON.parse(data);
    
    res.json(radars);
  } catch (error) {
    logger.error('Error reading radars:', error);
    res.status(500).json({ error: 'Failed to load radar data' });
  }
});

/**
 * GET /api/closest-radar
 * Find closest radar to coordinates
 */
app.get('/api/closest-radar', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    
    if (!lat || !lon) {
      return res.status(400).json({ error: 'Missing lat or lon parameters' });
    }
    
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    
    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }
    
    const radarsPath = path.join(__dirname, 'radars.json');
    const data = await fs.readFile(radarsPath, 'utf8');
    const radarsData = JSON.parse(data);
    
    // Convert to object format for findClosestRadar
    const radarsObj = {};
    radarsData.features.forEach(feature => {
      radarsObj[feature.properties.id] = feature;
    });
    
    const closest = findClosestRadar(latitude, longitude, radarsObj);
    
    res.json(closest);
  } catch (error) {
    logger.error('Error finding closest radar:', error);
    res.status(500).json({ error: 'Failed to find closest radar' });
  }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/**
 * Clean up old cache files periodically
 */
async function cleanupCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    let deleted = 0;
    
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = await fs.stat(filePath);
      const age = (now - stats.mtimeMs) / 1000;
      
      if (age > DISK_CACHE_TTL) {
        await fs.unlink(filePath);
        deleted++;
      }
    }
    
    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} expired cache files`);
    }
  } catch (error) {
    logger.error('Cache cleanup error:', error);
  }
}

// Run cleanup every hour
setInterval(cleanupCache, 3600000);

// Start server
app.listen(PORT, () => {
  logger.info(`BoM Radar Proxy Server running on port ${PORT}`);
  logger.info(`Cache directory: ${CACHE_DIR}`);
  logger.info(`FTP source: ${FTP_HOST}${FTP_PATH}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
