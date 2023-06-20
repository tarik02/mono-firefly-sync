#!/usr/bin/env bash
set -Eeuo pipefail

curl -XPOST 'https://api.monobank.ua/personal/webhook' \
    -H"X-Token: $(jq -r '.monobank.token' config.json)" \
    -H"Content-Type: application/json" \
    -d"$(jq -n \
        --arg url "$(jq -r '.monobank.webhookUrl' config.json)" \
        '{"webHookUrl":$url}' \
    )"

