FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Python + runtime deps for ODA (Qt5 + PROJ)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3-pip python3.11-dev \
        wget ca-certificates \
        libqt5widgets5 libqt5gui5 libqt5core5a libqt5xml5 \
        libglib2.0-0 libgl1 libxkbcommon-x11-0 libdbus-1-3 \
        proj-bin libproj-dev \
    && rm -rf /var/lib/apt/lists/*

# ── ODA File Converter (free) — DXF → DWG ────────────────────────────────────
# Download the .deb from Open Design Alliance.
# If the URL is unreachable during build the layer is skipped gracefully;
# the service will fall back to returning DXF files.
ARG ODA_VERSION=24.3
RUN wget -q --tries=2 --timeout=30 \
        "https://download.opendesign.com/guestfiles/Demo/ODAFileConverter_QT5_lnxX86_64dll_${ODA_VERSION}.deb" \
        -O /tmp/oda.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/oda.deb \
    && rm /tmp/oda.deb \
    && rm -rf /var/lib/apt/lists/* \
    || echo "⚠  ODA File Converter unavailable — DXF fallback will be used"

# ── Python dependencies ───────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
