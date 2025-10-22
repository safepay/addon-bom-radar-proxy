# BoM Radar Proxy Add-on Documentation

## How It Works

### Caching Strategy

The add-on uses a smart caching strategy based on image timestamps:

1. **Historical Images** (>30 minutes old from timestamp):
   - Downloaded once and cached for 24 hours
   - Always served from cache if available
   - Ideal for radar loops showing past weather

2. **Current Images** (<30 minutes old from timestamp):
   - Re-downloaded if timestamp is >10 minutes old
   - Ensures you always see recent radar data
   - Respects BoM's ~10 minute update interval

3. **Timestamp Lists**:
   - Refreshed only when requested by the card
   - Rate-limited to once per 10 minutes per radar
   - Prevents unnecessary FTP connections

### Image Timestamp Logic

The cache uses the **timestamp in the image filename** (not file modification time) to determine freshness:
```
IDR023.T.202410231430.png
              ^--- This timestamp is used for 10-minute expiry logic
```

This ensures accurate caching regardless of when the file was downloaded.

### Network Flow

**Local Access:**
```
Card → Home Assistant → Add-on (ingress) → BoM FTP
```

**Remote Access (Nabu Casa/DuckDNS):**
```
Mobile App → Nabu Casa → Home Assistant → Add-on (ingress) → BoM FTP
```

The add-on is accessed through Home Assistant's ingress system, which means:
- ✅ Works automatically with remote access
- ✅ Uses Home Assistant's authentication
- ✅ No additional ports or configuration needed
- ✅ Secure by default

## Configuration Details

### Log Level

Controls the verbosity of logging:
- `debug` - Very detailed, useful for troubleshooting
- `info` - Standard operational logs (recommended)
- `warn` - Only warnings and errors
- `error` - Only errors

### Cache TTL

How long images are kept on disk before being deleted:
- Default: 24 hours
- Minimum: 1 hour
- Maximum: 168 hours (7 days)

Older images are automatically cleaned up to prevent disk space issues.

### Timestamp Refresh Interval

How often the add-on can fetch new timestamp lists from BoM:
- Default: 600 seconds (10 minutes)
- Minimum: 300 seconds (5 minutes)
- Maximum: 3600 seconds (1 hour)

This prevents excessive FTP connections while keeping data fresh.

### Max Cache Size

Maximum disk space for cached images:
- Default: 1000 MB (1 GB)
- Minimum: 100 MB
- Maximum: 10000 MB (10 GB)

When limit is reached, oldest images are deleted first (LRU policy).

## Performance

### Bandwidth Usage

- **First Load**: Downloads all requested images (~5-10 MB for 2 hours of data)
- **Subsequent Loads**: Serves from cache (near zero bandwidth)
- **Updates**: Only downloads new images as they become available

### Disk Usage

Typical usage for one radar with 2 hours of cached data:
- ~20-30 images
- ~100-200 KB per image
- ~5-10 MB total

### Response Times

- **Cache Hit**: <50ms (reading from disk)
- **Cache Miss**: 2-5 seconds (FTP download)
- **Timestamp List**: 1-3 seconds (FTP directory listing)

## Troubleshooting

### Add-on won't start

Check the logs for errors:
1. Go to **Settings** → **Add-ons** → **BoM Radar Proxy**
2. Click the **Log** tab
3. Look for error messages

Common issues:
- **Port conflict**: Another service using port 3000
- **Disk space**: Not enough space for cache directory
- **Permissions**: Cache directory not writable

### Images not loading

1. Check add-on is running
2. Verify ingress is enabled in add-on configuration
3. Check add-on logs for FTP errors
4. Test API endpoint: `/api/health`

### Slow performance

1. Check cache statistics: `/api/cache/stats`
2. Verify cache size limit isn't too small
3. Check network connectivity to BoM FTP server
4. Review logs for repeated download failures

### Cache fills up too fast

Increase `max_cache_size_mb` or decrease `cache_ttl_hours`:
```yaml
max_cache_size_mb: 2000  # Increase to 2GB
cache_ttl_hours: 12      # Reduce to 12 hours
```

## Advanced Usage

### Multiple Radar Locations

The card supports viewing multiple radars. Each radar's images are cached independently.

### API Access

You can access the API directly (requires Home Assistant authentication):
```bash
# Get available radars
curl http://homeassistant.local:8123/api/hassio_ingress/xyz/api/radars

# Get timestamps for Melbourne radar
curl http://homeassistant.local:8123/api/hassio_ingress/xyz/api/timestamps/IDR023

# Get specific radar image
curl http://homeassistant.local:8123/api/hassio_ingress/xyz/api/radar/IDR023/202410231430 > radar.png
```

Replace `xyz` with your actual ingress token.

## Data Source

All radar data is sourced from the Australian Bureau of Meteorology:
- FTP Server: `ftp.bom.gov.au`
- Path: `/anon/gen/radar/`
- Update Frequency: ~6-10 minutes per radar

## Privacy

This add-on:
- ✅ Does NOT send any data to external services (except BoM FTP)
- ✅ Does NOT track or log user activity
- ✅ Stores data only in your Home Assistant instance
- ✅ Uses only publicly available BoM data

## Support

- 📖 Documentation: [GitHub Wiki](https://github.com/safepay/addon-bom-radar-proxy/wiki)
- 🐛 Issues: [GitHub Issues](https://github.com/safepay/addon-bom-radar-proxy/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/safepay/addon-bom-radar-proxy/discussions)
