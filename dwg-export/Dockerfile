FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Python + runtime deps for ODA (Qt6 + PROJ) + xvfb for headless GUI.
# The ODA .deb declares its own Qt6 dependencies, which `apt-get install ./*.deb`
# resolves automatically; we pre-install the common X/GL/font libs it needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3-pip python3.11-dev \
        ca-certificates xvfb \
        libglib2.0-0 libgl1 libxkbcommon0 libxkbcommon-x11-0 \
        libdbus-1-3 libfontconfig1 libfreetype6 \
        libsm6 libice6 \
        libxcb1 libxcb-cursor0 libxcb-icccm4 libxcb-image0 \
        libxcb-keysyms1 libxcb-randr0 libxcb-render0 libxcb-render-util0 \
        libxcb-shape0 libxcb-shm0 libxcb-sync1 libxcb-util1 \
        libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 libxcb-glx0 \
        proj-bin libproj-dev \
    && rm -rf /var/lib/apt/lists/*

# ── ODA File Converter (free) — DXF → DWG ────────────────────────────────────
# The .deb is bundled in vendor/ (downloaded manually from opendesign.com,
# whose download links are session-based and can't be fetched at build time).
# Any *.deb dropped in vendor/ is installed. If none is present, the build
# still succeeds and the service falls back to returning DXF files.
COPY vendor/ /tmp/vendor/
RUN if ls /tmp/vendor/*.deb >/dev/null 2>&1; then \
        apt-get update \
        && apt-get install -y --no-install-recommends /tmp/vendor/*.deb \
        && rm -rf /var/lib/apt/lists/* /tmp/vendor/*.deb \
        && echo "✓ ODA File Converter installed"; \
    else \
        echo "⚠  No ODA .deb in vendor/ — DXF fallback will be used"; \
    fi

# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
