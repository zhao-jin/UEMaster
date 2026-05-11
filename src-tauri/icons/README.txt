Place app icons here:
  icon.png  (512x512 PNG)
  icon.ico  (multi-size Windows ICO)

Tauri's `cargo tauri icon <source.png>` can generate the full set automatically:
  npm run tauri icon path/to/source.png

Until you provide real icons, the tray will fall back to a 1x1 placeholder
(see src/tray.rs default_icon()).
