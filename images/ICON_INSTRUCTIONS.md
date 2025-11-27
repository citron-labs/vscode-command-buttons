# Icon Creation Instructions

The icon SVG file has been created at `images/icon.svg`.

## Quick Ways to Convert SVG to PNG (128x128):

### Option 1: Online Converter (Easiest)
1. Go to https://cloudconvert.com/svg-to-png or https://svgtopng.com/
2. Upload `images/icon.svg`
3. Set dimensions to 128x128 pixels
4. Download as `command-buttons-icon.png`
5. Save to the `images/` folder

### Option 2: VS Code Extension
1. Install "SVG" extension by jock.svg
2. Right-click `icon.svg` → Export PNG
3. Choose 128x128 size
4. Save as `command-buttons-icon.png`

### Option 3: Using Inkscape (if installed)
```bash
inkscape icon.svg --export-filename=command-buttons-icon.png --export-width=128 --export-height=128
```

### Option 4: Using ImageMagick (if installed)
```bash
magick convert icon.svg -resize 128x128 command-buttons-icon.png
```

Once you have the PNG file saved as `images/command-buttons-icon.png`, you can repackage with:
```bash
npm run compile
vsce package
```
