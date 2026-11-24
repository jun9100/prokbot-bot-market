---
name: Container & Disk Health Audit
description: Structured read-only triage playbook for Docker Compose crash loops, OOM kills, network timeouts, and SSD/HDD disk bloat.
---

# Container & Disk Health Audit

1. **Snapshot First**: Gather container status (`RestartCount`, `OOMKilled`, health status), last 50 error lines, and filesystem headroom (`df -h`, `docker system df`).
2. **Isolate Root Cause**: Distinguish config syntax errors, port conflicts, missing bind mounts, DNS/proxy timeouts, and disk-full failures before proposing any restart.
3. **Safe Remediation**: Provide exact backup steps first, avoid `docker volume prune` or `rm -rf` on data directories, and verify service health after recovery.
