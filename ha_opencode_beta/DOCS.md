# OpenCode Beta

This is the **beta channel** for the OpenCode add-on. It contains experimental features and fixes that are being validated before inclusion in the stable release.

**You can install this alongside the stable OpenCode add-on.** Both will appear in the sidebar (as "OpenCode" and "OpenCode Beta") and operate independently.

## Current Beta Changes

- **Beta baseline reset**: `1.9.0b0` is based on the current stable OpenCode add-on release and does not include beta-only feature changes yet.

## Add-on Folder Access

OpenCode mounts `/addons` and `/addon_configs` for Home Assistant add-on development access. Enable **Add-on Folder Guidance** in the add-on configuration and restart to show these paths in the terminal. This option updates guidance, but the mounts are static add-on metadata and are not a hard filesystem permission boundary.

Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

## Resource Usage

OpenCode snapshots are disabled by default in this add-on to reduce memory and disk pressure on Home Assistant systems. File watching also ignores noisy internal paths such as `.storage/`, `.cloud/`, caches, logs, and the Home Assistant database. You can override these defaults with **Custom OpenCode Configuration (JSON)** if you need OpenCode's built-in snapshot/undo behavior.

## Zigbee2MQTT URL

If you configure `z2m_url` for zigporter commands, use a full URL such as `http://homeassistant.local:8099`. Host/IP-only values are accepted and treated as `http://`.

## Reporting Issues

If you encounter problems with the beta, please report them at:
https://github.com/magnusoverli/opencode/issues

Include the add-on logs (Settings > Add-ons > OpenCode Beta > Log) in your report.
