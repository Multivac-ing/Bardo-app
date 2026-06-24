# Privacy and data retention

Bardo is local-first. The current MVP has no cloud backend, analytics, account system, or remote audio storage.

## Data in the server process

The server keeps connected device labels, readiness, timing values, calibration values, and any uploaded audio asset in memory only. They disappear when the server stops. The host token is generated for each server process and is not written to disk.

## Data in the browser

Each phone stores its chosen display name, calibration value, and reconnect identifier in browser local storage. Clearing site data removes them.

## Data sent on the local network

Phones send their label, browser user agent, audio readiness, clock-sync measurements, and calibration value to the local host. An uploaded audio file is sent only between the host and phones in the active local session.

## Future changes

Any cloud service, microphone capture, diagnostics export, or account feature must update this document before it ships.
