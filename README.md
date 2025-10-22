# BoM Radar Proxy Add-on

[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)

Bureau of Meteorology radar image proxy with intelligent caching for Home Assistant.

## About

This add-on provides a caching proxy for Australian Bureau of Meteorology radar imagery. It downloads radar images from BoM's FTP server on-demand and caches them locally for fast access and reduced bandwidth usage.

## Features

- 🚀 **On-demand retrieval** - Downloads images only when requested
- 💾 **Smart caching** - Historical images cached 24h, current images refresh every 10min
- 🌐 **Ingress support** - Secure access via Home Assistant
- 📱 **Mobile compatible** - Works with HA mobile apps
- 🔒 **Authenticated** - Uses HA's built-in security
- 📊 **Cache management** - Automatic cleanup and size limits
- 🎯 **Location aware** - Finds closest radar to your location

## Installation

### Via Add-on Store

1. **Settings** → **Add-ons** → **Add-on Store**
2. Click **⋮** (menu) → **Repositories**
3. Add: `https://github.com/safepay/addon-bom-radar-proxy`
4. Find "**BoM Radar Proxy**"
5. Click **Install**
6. Click **Start**

### Configuration

Default settings work for most users:
```yaml
log_level: info
cache_ttl_hours: 24
timestamp_refresh_interval: 600
max_cache_size_mb: 1000
```

#### Options

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Logging verbosity: debug, info, warn, error |
| `cache_ttl_hours` | `24` | Hours to cache images (1-168) |
| `timestamp_refresh_interval` | `600` | Seconds between timestamp refreshes (300-3600) |
| `max_cache_size_mb` | `1000` | Maximum cache size in MB (100-10000) |

## Usage

After installation:

1. Start the add-on
2. Install the [Leaflet BoM Radar Card](https://github.com/safepay/leaflet-bom-radar-card)
3. Add card to your dashboard
4. Card automatically uses the add-on via ingress

### Web UI

Click "**Open Web UI**" to view:
- Cache statistics
- Current configuration
- API endpoints
- System health

## API Endpoints

The add-on exposes these endpoints:

- `GET /` - Dashboard and statistics
- `GET /api/radars` - List all radars
- `GET /api/closest-radar?lat={lat}&lon={lon}` - Find closest radar
- `GET /api/timestamps/{radarId}` - Get available timestamps
- `GET /api/radar/{radarId}/{timestamp}` - Get radar image
- `GET /api/cache/stats` - Cache statistics
- `GET /health` - Health check

## How It Works

### Caching Strategy

**Historical Images** (>30 minutes old):
- Downloaded once
- Cached for 24 hours
- Perfect for reviewing past weather

**Current Images** (<30 minutes old):
- Re-downloaded if >10 minutes old
- Ensures fresh data
- Respects BoM's ~10 minute update cycle

**Timestamp Lists**:
- Refreshed on demand
- Rate-limited to once per 10 minutes per radar
- Prevents excessive FTP connections

### Cache Management

- **Automatic cleanup** - Old files removed after TTL expires
- **Size limits** - Enforces max cache size with LRU eviction
- **Smart caching** - Uses image timestamp (not file date) for freshness

## Troubleshooting

### Add-on won't start
- Check logs: Add-on → Log tab
- Verify disk space (need 1GB+)
- Ensure port 3000 available

### "Cannot GET /"
- This is normal if accessing root directly
- The card uses `/api/*` endpoints
- Or rebuild add-on with latest code for dashboard

### Images not loading
- Check add-on is running
- View logs for FTP errors
- Test with Web UI
- Verify internet connectivity

### Slow performance
- Check cache stats in Web UI
- Increase `max_cache_size_mb`
- Verify BoM FTP accessibility

## Support

- 📖 [Documentation](DOCS.md)
- 🐛 [Report Issues](https://github.com/safepay/addon-bom-radar-proxy/issues)
- 💬 [Discussions](https://github.com/safepay/addon-bom-radar-proxy/discussions)

## Related

- 📦 [Leaflet BoM Radar Card](https://github.com/safepay/leaflet-bom-radar-card) - Frontend card

## License

MIT License - see [LICENSE](LICENSE) file

[releases-shield]: https://img.shields.io/github/release/safepay/addon-bom-radar-proxy.svg
[releases]: https://github.com/safepay/addon-bom-radar-proxy/releases
[license-shield]: https://img.shields.io/github/license/safepay/addon-bom-radar-proxy.svg
