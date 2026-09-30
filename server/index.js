import app from './app.js';

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`\n  ✦ PixelFlow running at http://127.0.0.1:${PORT}`);
  if (!process.env.SPOTIFY_CLIENT_ID) {
    console.log('    Spotify player is unconfigured — copy .env.example to .env to enable it.');
  }
  console.log('');
});
