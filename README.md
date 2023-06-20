# monosync

## Setting up

1. Copy config.example.json to config.json.
2. Set `monobank.token` to personal token taken from https://api.monobank.ua
3. Set `firefly.token` to personal access token created in your Firefly profile.
4. Install dependencies by running `yarn`.
5. Start the server (`node index.js`).
6. Run `setup-webhook.sh` (it's important to run this only after server is ready since monobank will check if it is available).

