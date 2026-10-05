# The SSH tunnel to the brands' server (D-482): autossh holding local forwards to each
# brand's Postgres, which listens on the brands' server's loopback only. The account on the
# far side is tunnel-only (`restrict`, `permitopen`, no shell): see docs/runbooks/mother-deploy.md.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache openssh-client autossh && adduser -D -u 10001 tunnel
USER tunnel
ENTRYPOINT ["/bin/sh", "/etc/tunnel/run.sh"]
