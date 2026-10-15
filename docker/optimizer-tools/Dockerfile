# optimizer-tools: nächtliches Training des Anlagen-Zwillings, Replay der Entscheidungsmaschine und Tageskennzahlen neben den Daten (NAS).
# Bauen aus der Wurzel des Repos:  docker build -f docker/optimizer-tools/Dockerfile -t optimizer-tools:1 .
# Alle Werkzeuge nutzen nur Node-Builtins (fs, path) und die Python-Standardbibliothek: keine npm-/pip-Pakete.
FROM node:22.23.3-alpine3.24

ARG OT_VERSION=dev
LABEL org.opencontainers.image.title="optimizer-tools" \
      org.opencontainers.image.description="Training Anlagen-Zwilling, Replay Entscheidungsmaschine, Tageskennzahlen (nur lesen, ohne Netz)" \
      org.opencontainers.image.source="https://github.com/fl0wb0b/HeishaMoNR" \
      org.opencontainers.image.version="${OT_VERSION}"

# python3 für die Steuerung, Training-Hülle und Kennzahlen; tzdata für Europe/Berlin (Sommer-/Winterzeit im Zeitplan).
# Eigener Benutzer 10001: NICHT uid 1000 (= node im Image und node-red auf der NAS), damit owm.json/vrm.json (Modus 600, uid 1000) unlesbar bleiben.
RUN apk add --no-cache python3 tzdata \
 && addgroup -S -g 10001 ot \
 && adduser -S -D -H -u 10001 -G ot -s /sbin/nologin ot \
 && mkdir -p /app/tools /ergebnis \
 && chown 10001:10001 /ergebnis

ENV TZ=Europe/Berlin \
    OT_DATEN=/daten \
    OT_ERGEBNIS=/ergebnis \
    OT_VERSION=${OT_VERSION} \
    ZEITPLAN=06:40 \
    NACHHOLEN=1 \
    NODE_OPTIONS=--max-old-space-size=700 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY tools/engine_core.js tools/engine_replay.js tools/replay_tag.js tools/wp_zwilling.js tools/wp_training.js \
     tools/wp_training_nacht.py tools/kennzahlen_tag.py /app/tools/
COPY docker/optimizer-tools/ot.py /app/ot.py
RUN chown -R root:root /app && chmod -R a+rX,go-w /app && python3 -c "import ast,sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" /app/ot.py /app/tools/*.py \
 && node --check /app/tools/replay_tag.js && node --check /app/tools/wp_training.js

USER 10001:10001
VOLUME ["/ergebnis"]
HEALTHCHECK --interval=2m --timeout=20s --start-period=1m --retries=3 CMD ["python3", "/app/ot.py", "gesund"]
ENTRYPOINT ["python3", "/app/ot.py"]
CMD ["dienst"]
