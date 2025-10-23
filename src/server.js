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

// Resolution suffix mapping
const RESOLUTION_SUFFIX = {
  64: '1',
  128: '2',
  256: '3',
  512: '4'  // Composite - may skip this
};

// Resolutions to support (skip 512 composite)
const SUPPORTED_RESOLUTIONS = [64, 128, 256];

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

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Log request
  logger.debug('Incoming request', {
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    };
    
    if (res.statusCode >= 400) {
      logger.warn('Request completed with error', logData);
    } else {
      logger.debug('Request completed', logData);
    }
  });
  
  next();
});


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
 * Build radar URL with resolution suffix
 */
function buildRadarUrl(radarId, timestamp, resolution) {
  const suffix = RESOLUTION_SUFFIX[resolution];
  if (!suffix) {
    throw new Error(`Invalid resolution: ${resolution}`);
  }
  
  // Format: IDRxxxS.T.yyyyMMddHHmm.png where S is the resolution suffix
  const filename = `${radarId}${suffix}.T.${timestamp}.png`;
  const remotePath = path.join(FTP_PATH, filename);
  
  return { filename, remotePath };
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
async function downloadFromFTP(radarId, timestamp, resolution) {
  const client = await connectFTP();
  const { remotePath } = buildRadarUrl(radarId, timestamp, resolution);
  
  return new Promise((resolve, reject) => {
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
 * Uses timestamp from filename and resolution to determine cache freshness
 */
async function getRadarImage(radarId, timestamp, resolution) {
  logger.debug('getRadarImage called', { 
    radarId, 
    timestamp, 
    resolution,
    supportedResolutions: SUPPORTED_RESOLUTIONS 
  });
   
  // Validate resolution
  if (!SUPPORTED_RESOLUTIONS.includes(resolution)) {
    throw new Error(`Unsupported resolution: ${resolution}. Supported: ${SUPPORTED_RESOLUTIONS.join(', ')}`);
  }
  
  const cacheKey = `${radarId}_${timestamp}_${resolution}`;
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
          imageAge: Math.floor(imageAge),
          resolution: resolution
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
    const buffer = await downloadFromFTP(radarId, timestamp, resolution);
    
    // Save to cache
    await fs.writeFile(cachePath, buffer);
    logger.info(`Cached: ${cacheKey} (${Math.floor(buffer.length / 1024)}KB)`);
    
    // Check and enforce cache size limit
    checkCacheSize();
    
    return {
      buffer: buffer,
      fromCache: false,
      cacheAge: 0,
      imageAge: Math.floor(imageAge),
      resolution: resolution
    };
  } catch (error) {
    logger.error(`Failed to download ${cacheKey}:`, error.message);
    throw error;
  }
}

/**
 * List available timestamps for a radar
 */
/**
 * List available timestamps for a radar at a specific resolution
 */
async function listAvailableTimestamps(radarId, resolution, maxResults = 20, force = false) {
  const suffix = RESOLUTION_SUFFIX[resolution];
  if (!suffix) {
    throw new Error(`Invalid resolution: ${resolution}`);
  }
  
  const cacheKey = `timestamps_${radarId}_${resolution}`;
  const cached = metaCache.get(cacheKey);
  
  if (cached && !force) {
    const nextRefresh = getTimeUntilNextRefresh(radarId);
    logger.info(`Timestamp cache hit: ${radarId} ${resolution}km (next refresh in ${nextRefresh}s)`);
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
      
      // Filter files matching the radar ID pattern with resolution suffix
      const pattern = new RegExp(`^${radarId}${suffix}\\.T\\.(\\d{12})\\.png$`);
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
      
      logger.info(`Retrieved ${timestamps.length} timestamps for ${radarId} ${resolution}km`);
      
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
 * GET /api/radar/:radarId/:timestamp/:resolution
 */
app.get('/api/radar/:radarId/:timestamp/:resolution', async (req, res) => {
  try {
    const { radarId, timestamp, resolution } = req.params;
    
    if (!radarId.match(/^IDR\d{3}$/)) {
      return res.status(400).json({ error: 'Invalid radar ID format' });
    }
    
    if (!timestamp.match(/^\d{12}$/)) {
      return res.status(400).json({ error: 'Invalid timestamp format' });
    }
    
    const resNum = parseInt(resolution);
    if (!SUPPORTED_RESOLUTIONS.includes(resNum)) {
      return res.status(400).json({ 
        error: `Invalid resolution. Supported: ${SUPPORTED_RESOLUTIONS.join(', ')}km` 
      });
    }
    
    const result = await getRadarImage(radarId, timestamp, resNum);
    
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=600',
      'X-From-Cache': result.fromCache.toString(),
      'X-Cache-Age': result.cacheAge.toString(),
      'X-Image-Age': result.imageAge.toString(),
      'X-Resolution': result.resolution.toString(),
      'ETag': `${radarId}-${timestamp}-${resolution}`
    });
    
    res.send(result.buffer);
  } catch (error) {
    logger.error('Error serving radar image:', error);
    
    if (error.code === 550) {
      res.status(404).json({ error: 'Radar image not found' });
    } else {
      res.status(500).json({ error: 'Failed to retrieve radar image', details: error.message });
    }
  }
});

app.get('/api/timestamps/:radarId/:resolution', async (req, res) => {
  try {
    const { radarId, resolution } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const force = req.query.force === 'true';
    
    if (!radarId.match(/^IDR\d{3}$/)) {
      return res.status(400).json({ error: 'Invalid radar ID format' });
    }
    
    const resNum = parseInt(resolution);
    if (!SUPPORTED_RESOLUTIONS.includes(resNum)) {
      return res.status(400).json({ 
        error: `Invalid resolution. Supported: ${SUPPORTED_RESOLUTIONS.join(', ')}km` 
      });
    }
    
    const result = await listAvailableTimestamps(radarId, resNum, limit, force);
    
    res.set({
      'Cache-Control': 'public, max-age=600',
      'X-From-Cache': result.fromCache.toString()
    });
    
    res.json({
      radarId,
      resolution: resNum,
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
 * GET / 
 * Root endpoint - Simple dashboard
 */
app.get('/', async (req, res) => {
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
    
    const totalSizeMB = Math.round(totalSize / 1024 / 1024 * 100) / 100;
    const utilization = Math.round((totalSizeMB / MAX_CACHE_SIZE_MB) * 100);
    
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>BoM Radar Proxy</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            padding: 20px;
            min-height: 100vh;
          }
          .container {
            max-width: 900px;
            margin: 0 auto;
          }
          .card {
            background: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          }
          h1 {
            color: #667eea;
            margin-bottom: 8px;
            font-size: 28px;
          }
          .subtitle {
            color: #666;
            margin-bottom: 24px;
            font-size: 14px;
          }
          .status {
            display: inline-block;
            background: #10b981;
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 20px;
          }
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
          }
          .stat {
            background: #f9fafb;
            padding: 16px;
            border-radius: 8px;
            border-left: 4px solid #667eea;
          }
          .stat-label {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
          }
          .stat-value {
            font-size: 24px;
            font-weight: 700;
            color: #333;
          }
          .stat-unit {
            font-size: 14px;
            color: #666;
            margin-left: 4px;
          }
          .progress-bar {
            width: 100%;
            height: 24px;
            background: #e5e7eb;
            border-radius: 12px;
            overflow: hidden;
            margin-top: 8px;
          }
          .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea, #764ba2);
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 12px;
            font-weight: 600;
          }
          .api-list {
            list-style: none;
          }
          .api-item {
            background: #f9fafb;
            padding: 12px 16px;
            margin-bottom: 8px;
            border-radius: 6px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            border-left: 3px solid #667eea;
          }
          .method {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            margin-right: 8px;
          }
          .endpoint {
            color: #333;
          }
          .footer {
            text-align: center;
            color: white;
            margin-top: 24px;
            font-size: 13px;
          }
          .footer a {
            color: white;
            text-decoration: underline;
          }
          @media (max-width: 600px) {
            .stats-grid {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <h1>📡 BoM Radar Proxy</h1>
            <div class="subtitle">Bureau of Meteorology Radar Image Proxy & Cache</div>
            <div class="status">● RUNNING</div>
            
            <div class="stats-grid">
              <div class="stat">
                <div class="stat-label">Cached Images</div>
                <div class="stat-value">${imageCount}</div>
              </div>
              <div class="stat">
                <div class="stat-label">Cache Size</div>
                <div class="stat-value">${totalSizeMB}<span class="stat-unit">MB</span></div>
              </div>
              <div class="stat">
                <div class="stat-label">Max Cache</div>
                <div class="stat-value">${MAX_CACHE_SIZE_MB}<span class="stat-unit">MB</span></div>
              </div>
              <div class="stat">
                <div class="stat-label">Uptime</div>
                <div class="stat-value">${Math.floor(process.uptime() / 3600)}<span class="stat-unit">hrs</span></div>
              </div>
            </div>
            
            <div class="stat-label">Cache Utilization</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${utilization}%">${utilization}%</div>
            </div>
          </div>
          
          <div class="card">
            <h2 style="margin-bottom: 16px; font-size: 20px;">API Endpoints</h2>
            <ul class="api-list">
              <li class="api-item">
                <span class="method">GET</span>
                <span class="endpoint">/api/radars</span>
              </li>
              <li class="api-item">
                <span class="method">GET</span>
                <span class="endpoint">/api/closest-radar?lat={lat}&lon={lon}</span>
              </li>
              <li class="api-item">
                <span class="method">GET</span>
                <span class="endpoint">/api/timestamps/{radarId}/{resolution}</span>
              </li>
              <li class="api-item">
                <span class="method">GET</span>
                <span class="endpoint">/api/radar/{radarId}/{timestamp}/{resolution}</span>
              </li>
              <li class="api-item">
                <span class="method">GET</span>
                <span class="endpoint">/api/cache/stats</span>
              </li>
              <li class="api-item">
                <span class="method">GET</span>
                <span class="endpoint">/health</span>
              </li>
            </ul>
          </div>
          
          <div class="card">
            <h2 style="margin-bottom: 16px; font-size: 20px;">Configuration</h2>
            <div class="stats-grid">
              <div class="stat">
                <div class="stat-label">Timestamp Refresh</div>
                <div class="stat-value">${TIMESTAMP_REFRESH_INTERVAL / 1000}<span class="stat-unit">sec</span></div>
              </div>
              <div class="stat">
                <div class="stat-label">Image Refresh</div>
                <div class="stat-value">${CURRENT_IMAGE_REFRESH_INTERVAL / 1000}<span class="stat-unit">sec</span></div>
              </div>
              <div class="stat">
                <div class="stat-label">Cache TTL</div>
                <div class="stat-value">${DISK_CACHE_TTL / 3600}<span class="stat-unit">hrs</span></div>
              </div>
              <div class="stat">
                <div class="stat-label">FTP Source</div>
                <div class="stat-value" style="font-size: 12px;">ftp.bom.gov.au</div>
              </div>
            </div>
          </div>
          
          <div class="footer">
            <p>Add the <strong>Leaflet BoM Radar Card</strong> to your Home Assistant dashboard to view radar imagery.</p>
            <p style="margin-top: 8px;">
              <a href="https://github.com/safepay/leaflet-bom-radar" target="_blank">Documentation</a> • 
              <a href="/health">Health Check</a> • 
              <a href="/api/cache/stats">Cache Stats (JSON)</a>
            </p>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    logger.error('Error rendering dashboard:', error);
    res.status(500).send('Error loading dashboard');
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
app.listen(PORT, async () => {
  logger.info(`BoM Radar Proxy Add-on started`);
  logger.info(`Port: ${PORT}`);
  logger.info(`Cache directory: ${CACHE_DIR}`);
  logger.info(`FTP source: ${FTP_HOST}${FTP_PATH}`);
  logger.info(`Timestamp refresh interval: ${TIMESTAMP_REFRESH_INTERVAL / 1000}s`);
  logger.info(`Current image refresh interval: ${CURRENT_IMAGE_REFRESH_INTERVAL / 1000}s`);
  logger.info(`Cache TTL: ${DISK_CACHE_TTL / 3600}h`);
  logger.info(`Max cache size: ${MAX_CACHE_SIZE_MB}MB`);
  
  // Add diagnostics
  try {
    const cacheStats = await fs.stat(CACHE_DIR);
    logger.debug('Cache directory stats', { 
      exists: true,
      isDirectory: cacheStats.isDirectory() 
    });
  } catch (error) {
    logger.error('Cache directory issue', { error: error.message });
  }
  
  // Test FTP connection
  try {
    const testClient = await connectFTP();
    testClient.end();
    logger.info('FTP connection test: SUCCESS');
  } catch (error) {
    logger.error('FTP connection test: FAILED', { error: error.message });
  }
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
