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
const logLevel = process.env.LOG_LEVEL || 'info';
const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let msg = `${timestamp} [${level.toUpperCase()}] ${message}`;
      if (Object.keys(meta).length > 0) {
        msg += ` ${JSON.stringify(meta)}`;
      }
      return msg;
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
});

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = process.env.CACHE_DIR || '/data/cache';
const FTP_HOST = 'ftp.bom.gov.au';
const FTP_PATH = '/anon/gen/radar/';
const TIMESTAMP_REFRESH_INTERVAL = (parseInt(process.env.TIMESTAMP_REFRESH_INTERVAL) || 600) * 1000;
const CURRENT_IMAGE_REFRESH_INTERVAL = 600000; // 10 minutes for current images
const CURRENT_IMAGE_THRESHOLD = 1800; // 30 minutes - images newer than this are "current"
const DISK_CACHE_TTL = (parseInt(process.env.CACHE_TTL_HOURS) || 24) * 3600;
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB) || 1000;

// Memory cache for metadata
const metaCache = new NodeCache({ stdTTL: TIMESTAMP_REFRESH_INTERVAL / 1000, checkperiod: 120 });

// Track last timestamp refresh time per radar
const lastTimestampRefresh = new Map();

// Configure Express
app.use(helmet({
  contentSecurityPolicy: false, // Allow ingress iframe
}));
app.use(compression());
app.use(cors({
  origin: true,
  credentials: true
}));
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

/**
 * Parse timestamp string to Date object
 */
function parseTimestamp(timestamp) {
  const year = parseInt(timestamp.substring(0, 4));
  const month = parseInt(timestamp.substring(4, 6)) - 1;
  const day = parseInt(timestamp.substring(6, 8));
  const hour = parseInt(timestamp.substring(8, 10));
  const minute = parseInt(timestamp.substring(10, 12));
  
  return new Date(year, month, day, hour, minute);
}

/**
 * Check if enough time has passed since last timestamp refresh
 */
function canRefreshTimestamps(radarId) {
  const lastRefresh = lastTimestampRefresh.get(radarId);
  if (!lastRefresh) {
    return true;
  }
  
  const timeSinceLastRefresh = Date.now() - lastRefresh;
  return timeSinceLastRefresh >= TIMESTAMP_REFRESH_INTERVAL;
}

/**
 * Update last timestamp refresh time
 */
function updateTimestampRefreshTime(radarId) {
  lastTimestampRefresh.set(radarId, Date.now());
}

/**
 * Get time until next allowed timestamp refresh
 */
function getTimeUntilNextRefresh(radarId) {
  const lastRefresh = lastTimestampRefresh.get(radarId);
  if (!lastRefresh) {
    return 0;
  }
  
  const timeSinceLastRefresh = Date.now() - lastRefresh;
  const timeRemaining = TIMESTAMP_REFRESH_INTERVAL - timeSinceLastRefresh;
  return Math.max(0, Math.ceil(timeRemaining / 1000));
}

/**
 * Connect to BoM FTP server
 */
function connectFTP() {
  return new Promise((resolve, reject) => {
    const client = new ftp();
    
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('FTP connection timeout'));
    }, 30000);
    
    client.on('ready', () => {
      clearTimeout(timeout);
      resolve(client);
    });
    
    client.on('error', (err) => {
      clearTimeout(timeout);
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
async function downloadFromFTP(radarId, timestamp) {
  const client = await connectFTP();
  
  return new Promise((resolve, reject) => {
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
 * Uses timestamp from filename to determine if image should be refreshed
 */
async function getRadarImage(radarId, timestamp) {
  const cacheKey = `${radarId}_${timestamp}`;
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.png`);
  
  // Parse the timestamp to get the actual image time
  const timestampDate = parseTimestamp(timestamp);
  const imageAge = (Date.now() - timestampDate.getTime()) / 1000; // seconds since image timestamp
  const isCurrent = imageAge < CURRENT_IMAGE_THRESHOLD; // Is this a "current" image (<30 min old)?
  
  // Check if file exists in cache
  try {
    const stats = await fs.stat(cachePath);
    const fileCacheAge = (Date.now() - stats.mtimeMs) / 1000; // seconds since file was cached
    
    // Check if cache has expired (24 hours on disk)
    if (fileCacheAge >= DISK_CACHE_TTL) {
      logger.info(`Cache expired: ${cacheKey} (file age: ${Math.floor(fileCacheAge)}s)`);
      await fs.unlink(cachePath);
    } else {
      // If historical image (>30 min old from timestamp), always use cache
      // If current image (<30 min old from timestamp), only use if image timestamp is <10 min old
      if (!isCurrent || imageAge < (CURRENT_IMAGE_REFRESH_INTERVAL / 1000)) {
        logger.info(`Cache hit: ${cacheKey} (image timestamp ${Math.floor(imageAge)}s ago, cached ${Math.floor(fileCacheAge)}s ago, current: ${isCurrent})`);
        return {
          buffer: await fs.readFile(cachePath),
          fromCache: true,
          cacheAge: Math.floor(fileCacheAge),
          imageAge: Math.floor(imageAge)
        };
      } else {
        logger.info(`Current image timestamp past 10min threshold: ${cacheKey} (timestamp is ${Math.floor(imageAge)}s old)`);
        await fs.unlink(cachePath);
      }
    }
  } catch (error) {
    // File doesn't exist, continue to download
    logger.debug(`Cache miss: ${cacheKey}`);
  }
  
  // Download from FTP immediately
  try {
    logger.info(`Downloading radar image: ${cacheKey} (timestamp is ${Math.floor(imageAge)}s old)`);
    const buffer = await downloadFromFTP(radarId, timestamp);
    
    // Save to cache
    await fs.writeFile(cachePath, buffer);
    logger.info(`Cached: ${cacheKey} (${Math.floor(buffer.length / 1024)}KB)`);
    
    // Check and enforce cache size limit
    checkCacheSize();
    
    return {
      buffer: buffer,
      fromCache: false,
      cacheAge: 0,
      imageAge: Math.floor(imageAge)
    };
  } catch (error) {
    logger.error(`Failed to download ${cacheKey}:`, error.message);
    throw error;
  }
}

/**
 * List available timestamps for a radar
 */
async function listAvailableTimestamps(radarId, maxResults = 20, force = false) {
  const cacheKey = `timestamps_${radarId}`;
  const cached = metaCache.get(cacheKey);
  
  if (cached && !force) {
    const nextRefresh = getTimeUntilNextRefresh(radarId);
    logger.info(`Timestamp cache hit: ${radarId} (next refresh in ${nextRefresh}s)`);
    return {
      timestamps: cached,
      fromCache: true,
      nextRefreshIn: nextRefresh
    };
  }
  
  if (!force && !canRefreshTimestamps(radarId)) {
    const waitTime = getTimeUntilNextRefresh(radarId);
    logger.warn(`Timestamp refresh rate limited for ${radarId}, ${waitTime}s remaining`);
    
    if (cached) {
      return {
        timestamps: cached,
        fromCache: true,
        nextRefreshIn: waitTime,
        rateLimited: true
      };
    }
    
    throw new Error(`Rate limit: Please wait ${waitTime} seconds before refreshing timestamps for ${radarId}`);
  }
  
  const client = await connectFTP();
  
  return new Promise((resolve, reject) => {
    client.list(FTP_PATH, (err, list) => {
      client.end();
      
      if (err) {
        reject(err);
        return;
      }
      
      const pattern = new RegExp(`^${radarId}\\.T\\.(\\d{12})\\.png$`);
      const timestamps = list
        .filter(item => item.type === '-' && pattern.test(item.name))
        .map(item => {
          const match = item.name.match(pattern);
          return match ? match[1] : null;
        })
        .filter(Boolean)
        .sort()
        .reverse()
        .slice(0, maxResults);
      
      metaCache.set(cacheKey, timestamps);
      updateTimestampRefreshTime(radarId);
      
      logger.info(`Retrieved ${timestamps.length} timestamps for ${radarId}`);
      
      resolve({
        timestamps: timestamps,
        fromCache: false,
        nextRefreshIn: TIMESTAMP_REFRESH_INTERVAL / 1000
      });
    });
  });
}

/**
 * Find closest radar to given coordinates
 */
function findClosestRadar(lat, lon, radarData) {
  let closestRadar = null;
  let minDistance = Infinity;
  
  for (const feature of radarData.features) {
    const radarLat = feature.geometry.coordinates[1];
    const radarLon = feature.geometry.coordinates[0];
    
    const R = 6371;
    const dLat = (radarLat - lat) * Math.PI / 180;
    const dLon = (radarLon - lon) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat * Math.PI / 180) * Math.cos(radarLat * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    if (distance < minDistance) {
      minDistance = distance;
      closestRadar = {
        id: feature.properties.id,
        name: feature.properties.name,
        state: feature.properties.state,
        distance: Math.round(distance * 10) / 10,
        lat: radarLat,
        lon: radarLon
      };
    }
  }
  
  return closestRadar;
}

/**
 * Check cache size and clean up if necessary
 */
async function checkCacheSize() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    let totalSize = 0;
    const fileStats = [];
    
    for (const file of files) {
      if (!file.endsWith('.png')) continue;
      
      const filePath = path.join(CACHE_DIR, file);
      const stats = await fs.stat(filePath);
      totalSize += stats.size;
      fileStats.push({ path: filePath, size: stats.size, mtime: stats.mtimeMs });
    }
    
    const totalSizeMB = totalSize / 1024 / 1024;
    
    if (totalSizeMB > MAX_CACHE_SIZE_MB) {
      logger.warn(`Cache size ${Math.round(totalSizeMB)}MB exceeds limit ${MAX_CACHE_SIZE_MB}MB, cleaning up...`);
      
      // Sort by modification time, oldest first
      fileStats.sort((a, b) => a.mtime - b.mtime);
      
      let freedSpace = 0;
      let deleted = 0;
      const targetSize = MAX_CACHE_SIZE_MB * 0.8 * 1024 * 1024; // Clean to 80% of limit
      
      for (const file of fileStats) {
        if (totalSize - freedSpace <= targetSize) break;
        
        await fs.unlink(file.path);
        freedSpace += file.size;
        deleted++;
      }
      
      logger.info(`Cleaned up ${deleted} old files, freed ${Math.round(freedSpace / 1024 / 1024)}MB`);
    }
  } catch (error) {
    logger.error('Error checking cache size:', error);
  }
}

/**
 * Clean up old cache files periodically
 */
async function cleanupCache() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    let deleted = 0;
    let freedSpace = 0;
    
    for (const file of files) {
      if (!file.endsWith('.png')) continue;
      
      const filePath = path.join(CACHE_DIR, file);
      const stats = await fs.stat(filePath);
      const age = (now - stats.mtimeMs) / 1000;
      
      if (age > DISK_CACHE_TTL) {
        freedSpace += stats.size;
        await fs.unlink(filePath);
        deleted++;
      }
    }
    
    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} expired cache files (freed ${Math.round(freedSpace / 1024 / 1024)}MB)`);
    }
  } catch (error) {
    logger.error('Cache cleanup error:', error);
  }
}

// API Routes

/**
 * GET /api/radar/:radarId/:timestamp
 */
app.get('/api/radar/:radarId/:timestamp', async (req, res) => {
  try {
    const { radarId, timestamp } = req.params;
    
    if (!radarId.match(/^IDR\d{2,4}$/)) {
      return res.status(400).json({ error: 'Invalid radar ID' });
    }
    
    if (!timestamp.match(/^\d{12}$/)) {
      return res.status(400).json({ error: 'Invalid timestamp format (expected: yyyyMMddHHmm)' });
    }
    
    const result = await getRadarImage(radarId, timestamp);
    
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=600',
      'X-From-Cache': result.fromCache.toString(),
      'X-Cache-Age': result.cacheAge.toString(),
      'X-Image-Age': result.imageAge.toString(),
      'ETag': `${radarId}-${timestamp}`
    });
    
    res.send(result.buffer);
  } catch (error) {
    logger.error('Error serving radar image:', error);
    
    if (error.code === 550) {
      res.status(404).json({ error: 'Radar image not found on BoM server' });
    } else {
      res.status(500).json({ error: 'Failed to retrieve radar image', details: error.message });
    }
  }
});

/**
 * GET /api/timestamps/:radarId
 */
app.get('/api/timestamps/:radarId', async (req, res) => {
  try {
    const { radarId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const force = req.query.force === 'true';
    
    if (!radarId.match(/^IDR\d{2,4}$/)) {
      return res.status(400).json({ error: 'Invalid radar ID' });
    }
    
    const result = await listAvailableTimestamps(radarId, limit, force);
    
    res.set({
      'Cache-Control': 'public, max-age=600',
      'X-From-Cache': result.fromCache.toString()
    });
    
    res.json({
      radarId,
      timestamps: result.timestamps,
      count: result.timestamps.length,
      fromCache: result.fromCache,
      nextRefreshIn: result.nextRefreshIn,
      rateLimited: result.rateLimited || false
    });
  } catch (error) {
    logger.error('Error listing timestamps:', error);
    
    if (error.message.includes('Rate limit')) {
      res.status(429).json({ 
        error: error.message,
        retryAfter: getTimeUntilNextRefresh(req.params.radarId)
      });
    } else {
      res.status(500).json({ error: 'Failed to list timestamps', details: error.message });
    }
  }
});

/**
 * GET /api/radars
 */
app.get('/api/radars', async (req, res) => {
  try {
    const radarsPath = path.join(__dirname, 'radars.json');
    const data = await fs.readFile(radarsPath, 'utf8');
    const radars = JSON.parse(data);
    
    res.set({
      'Cache-Control': 'public, max-age=86400',
    });
    
    res.json(radars);
  } catch (error) {
    logger.error('Error reading radars:', error);
    res.status(500).json({ error: 'Failed to load radar data' });
  }
});

/**
 * GET /api/closest-radar
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
    
    const closest = findClosestRadar(latitude, longitude, radarsData);
    
    res.set({
      'Cache-Control': 'public, max-age=3600',
    });
    
    res.json(closest);
  } catch (error) {
    logger.error('Error finding closest radar:', error);
    res.status(500).json({ error: 'Failed to find closest radar' });
  }
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    cacheDir: CACHE_DIR,
    config: {
      timestampRefreshInterval: TIMESTAMP_REFRESH_INTERVAL / 1000 + 's',
      currentImageRefreshInterval: CURRENT_IMAGE_REFRESH_INTERVAL / 1000 + 's',
      diskCacheTTL: DISK_CACHE_TTL / 3600 + 'h',
      maxCacheSizeMB: MAX_CACHE_SIZE_MB
    }
  });
});

/**
 * GET /api/cache/stats
 */
app.get('/api/cache/stats', async (req, res) => {
  try {
    const files = await fs.readdir(CACHE_DIR);
    let totalSize = 0;
    let imageCount = 0;
    
    for (const file of files) {
      if (file.endsWith('.png')) {
        const stats = await fs.stat(path.join(CACHE_DIR, file));
        totalSize += stats.size;
        imageCount++;
      }
    }
    
    res.json({
      imageCount,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      maxSizeMB: MAX_CACHE_SIZE_MB,
      utilization: Math.round((totalSize / 1024 / 1024 / MAX_CACHE_SIZE_MB) * 100) + '%',
      activeRadars: lastTimestampRefresh.size,
      memCacheKeys: metaCache.keys().length
    });
  } catch (error) {
    logger.error('Error getting cache stats:', error);
    res.status(500).json({ error: 'Failed to get cache statistics' });
  }
});

// Run cleanup every hour
setInterval(cleanupCache, 3600000);

// Check cache size every 10 minutes
setInterval(checkCacheSize, 600000);

// Start server
app.listen(PORT, () => {
  logger.info(`BoM Radar Proxy Add-on started`);
  logger.info(`Port: ${PORT}`);
  logger.info(`Cache directory: ${CACHE_DIR}`);
  logger.info(`FTP source: ${FTP_HOST}${FTP_PATH}`);
  logger.info(`Timestamp refresh interval: ${TIMESTAMP_REFRESH_INTERVAL / 1000}s`);
  logger.info(`Current image refresh interval: ${CURRENT_IMAGE_REFRESH_INTERVAL / 1000}s`);
  logger.info(`Cache TTL: ${DISK_CACHE_TTL / 3600}h`);
  logger.info(`Max cache size: ${MAX_CACHE_SIZE_MB}MB`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});
