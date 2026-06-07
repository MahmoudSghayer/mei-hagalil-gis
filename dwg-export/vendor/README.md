# ODA File Converter binary goes here

The DWG export needs the **ODA File Converter** (free) to convert DXF → DWG.
Its download links are session-based, so it can't be fetched automatically at
build time — you download it once and drop the `.deb` file in **this folder**.

## How to get it

1. Go to **https://www.opendesign.com/guestfiles/oda_file_converter**
2. (Free registration / accept the license if prompted)
3. Download the **Linux 64-bit Qt5 `.deb`** build, e.g.
   `ODAFileConverter_QT5_lnxX64_8.3dll_25.x.deb`
   - The **Qt5** `.deb` matches the libraries installed in the Dockerfile.
   - A `Qt6` build also works but may need different Qt6 libs in the Dockerfile.
4. Put the downloaded `.deb` file in this `vendor/` folder.
5. Commit it (the repo must be **private** — ODA's license does not allow
   redistributing the binary in a public repo).

The Dockerfile installs any `*.deb` it finds here automatically. If the folder
has no `.deb`, the build still succeeds and the service falls back to DXF.

> Check it worked after deploy: `GET /health` should show `"dwg_export": true`.
