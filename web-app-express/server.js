require('dotenv').config({ path: process.env.ENV_PATH || '.env' });
const app = require('./src/app');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`UNIMQ Express server listening on http://${HOST}:${PORT}`);
});
