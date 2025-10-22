# BoM Radar Proxy Add-on Documentation

## Configuration

### log_level
Controls logging verbosity:
- `debug` - Detailed logs for troubleshooting
- `info` - Standard operational logs (recommended)
- `warn` - Only warnings and errors
- `error` - Only errors

### cache_ttl_hours
How long to keep images before deletion:
- Default: 24 hours
- Min: 1 hour
- Max: 168 hours (7 days)

Older images automatically deleted to free space.

### timestamp_refresh_interval
Minimum time between fetching new timestamp lists:
- Default: 600 seconds (10 minutes)
- Min: 300 seconds (5 minutes)
- Max: 3600 seconds (1 hour)

Prevents excessive FTP connections.

### max_cache_size_mb
Maximum disk space for cached images:
- Default: 1000 MB (1 GB)
- Min: 100 MB
- Max: 10000 MB (10 GB)

When limit reached, oldest images deleted first (LRU).

## API Reference

### GET /api/radars
Returns GeoJSON of all radar locations.

**Response:**
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [144.755417, -37.855222]
      },
      "properties": {
        "id": "IDR023",
        "name": "Melbourne",
        "state": "VIC",
        "type": "High-resolution Doppler"
      }
    }
  ]
}
```

### GET /api/closest-radar
Find closest radar to coordinates.

**Parameters:**
- `lat` - Latitude
- `lon` - Longitude

**Example:**
```
GET /api/closest-radar?lat=-37.8136&lon=144.9631
```

**Response:**
```json
{
  "id": "IDR023",
  "name": "Melbourne",
  "state": "VIC",
  "distance": 5.2,
  "lat": -37.855222,
  "lon": 144.755417
}
```

### GET /api/timestamps/:radarId
Get available timestamps for a radar.

**Parameters:**
- `radarId` - Radar ID (e.g., IDR023)
- `limit` - Max results (optional, default: 20)

**Example:**
```
GET /api/timestamps/IDR023?limit=10
```

**Response:**
```json
{
  "radarId": "IDR023",
  "timestamps": [
    "202410231430",
    "202410231420",
    "202410231410"
  ],
  "count": 3,
  "fromCache": true,
  "nextRefreshIn": 450
}
```

### GET /api/radar/:radarId/:timestamp
Get radar image.

**Parameters:**
- `radarId` - Radar ID
- `timestamp` - Timestamp (yyyyMMddHHmm)

**Example:**
```
GET /api/radar/IDR023/202410231430
```

**Response:**
- Content-Type: `image/png`
- Headers:
  - `X-From-Cache`: true/false
  - `X-Cache-Age`: seconds
  - `X-Image-Age`: seconds

### GET /api/cache/stats
Get cache statistics.

**Response:**
```json
{
  "imageCount": 245,
  "totalSizeMB": 487.5,
  "maxSizeMB": 1000,
  "utilization": "49%",
  "activeRadars": 5,
  "memCacheKeys": 12
}
```

### GET /health
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "timestamp": "2024-10-23T10:30:00.000Z",
  "cacheDir": "/data/cache",
  "config": {
    "timestampRefreshInterval": "600s",
    "currentImageRefreshInterval": "600s",
    "diskCacheTTL": "24h",
    "maxCacheSizeMB": 1000
  }
}
```

## Performance

### Bandwidth Usage
- **First load**: 5-10 MB for 2 hours of data
- **Subsequent loads**: Near zero (served from cache)
- **Updates**: Only new images downloaded

### Disk Usage
Typical for one radar with 2 hours cached:
- ~20-30 images
- ~100-200 KB per image  
- ~5-10 MB total

### Response Times
- **Cache hit**: <50ms
- **Cache miss**: 2-5 seconds (FTP download)
- **Timestamp list**: 1-3 seconds

## Data Source

All data from Bureau of Meteorology:
- FTP: `ftp.bom.gov.au`
- Path: `/anon/gen/radar/`
- Update frequency: ~6-10 minutes per radar
- Public domain data

## Privacy

This add-on:
- ✅ Only connects to BoM FTP server
- ✅ Does not send data to third parties
- ✅ Does not track users
- ✅ Stores data only locally
- ✅ Uses only public BoM data

## Support

- 📖 [README](README.md)
- 🐛 [Issues](https://github.com/safepay/addon-bom-radar-proxy/issues)
- 💬 [Discussions](https://github.com/safepay/addon-bom-radar-proxy/discussions)
