FROM python:3.12-slim

WORKDIR /app

RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app/data \
    && chown app:app /app/data

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY pyproject.toml ./
COPY src/ ./src/
COPY config.ini ./
RUN pip install --no-cache-dir --no-deps .

# The installed package lives in site-packages, so the default "project root"
# lookup would not find config.ini; point to it explicitly. data_dir in
# config.ini is relative to this file => /app/data (mounted volume).
ENV PYTHONUNBUFFERED=1 \
    BG_PROMOS_CONFIG=/app/config.ini

USER app

ENTRYPOINT ["python", "-m", "bg_promos"]
CMD ["stats"]
