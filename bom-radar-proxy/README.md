# BoM Radar Proxy Add-on for Home Assistant

[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)

Bureau of Meteorology (BoM) radar image proxy with intelligent caching for Home Assistant.

## About

This add-on provides a caching proxy for Australian Bureau of Meteorology radar imagery. It downloads radar images from BoM's FTP server on-demand and caches them locally to reduce bandwidth usage and improve performance.

### Features

- 🚀 **On-demand image retrieval** - Downloads radar images only when requested
- 💾 **Intelligent caching** - Historical images cached for 24 hours, current images refresh every 10 minutes
- 🌐 **Remote access** - Works with Home Assistant's remote access (Nabu Casa, DuckDNS, etc.)
- 📱 **Mobile app support** - Full compatibility with Home Assistant mobile apps
- 🔒 **Secure** - Uses Home Assistant's built-in authentication via ingress
- 📊 **Cache management** - Automatic cleanup and size limits
- 🎯 **Auto-location** - Automatically selects closest radar to your Home Assistant location

## Installation

### Via Home Assistant Add-on Store (Recommended)

1. Navigate to **Settings** → **Add-ons** → **Add-on Store**
2. Click the menu (⋮) in the top right corner
3. Select **Repositories**
4. Add this repository URL: `https://github.com/safepay/addon-bom-radar-proxy`
5. Find "BoM Radar Proxy" in the add-on list
6. Click **Install**

### Manual Installation

1. Copy the `addon_bom_radar_proxy` directory to `/addons/` on your Home Assistant instance
2. Restart Home Assistant
3. Navigate to **Settings** → **Add-ons** → **Add-on Store**
4. Find "BoM Radar Proxy" (under "Local add-ons")
5. Click **Install**

## Configuration
```yaml
log_level: info
cache_ttl_hours: 24
timestamp_refresh_interval: 600
max_cache_size_mb: 1000
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `cache_ttl_hours` | `24` | How long to cache images (1-168 hours) |
| `timestamp_refresh_interval` | `600` | Seconds between timestamp list refreshes (300-3600) |
| `max_cache_size_mb` | `1000` | Maximum cache size in MB (100-10000) |

## Usage

After installation:

1. Start the add-on
2. Install the custom Lovelace card (see card documentation)
3. Add the card to your dashboard
4. The card will automatically use ingress to communicate with the add-on

## API Endpoints

The add-on exposes several API endpoints via ingress:

- `GET /api/radars` - List all available radars
- `GET /api/closest-radar?lat={lat}&lon={lon}` - Find closest radar
- `GET /api/timestamps/{radarId}` - Get available timestamps for a radar
- `GET /api/radar/{radarId}/{timestamp}` - Get radar image
- `GET /api/cache/stats` - Cache statistics
- `GET /health` - Health check

## Support

For issues and feature requests, please use the [GitHub issue tracker](https://github.com/safepay/addon-bom-radar-proxy/issues).

## License

MIT License - see [LICENSE](LICENSE) file for details

[releases-shield]: https://img.shields.io/github/release/safepay/addon-bom-radar-proxy.svg
[releases]: https://github.com/safepay/addon-bom-radar-proxy/releases
[license-shield]: https://img.shields.io/github/license/safepay/addon-bom-radar-proxy.svg
