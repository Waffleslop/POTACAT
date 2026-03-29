'use strict';

const { BrowserWindow } = require('electron');
const https = require('https');
const http = require('http');
const url = require('url');

/**
 * CloudAuth - Handles Google OAuth2 flow for Electron.
 *
 * Opens a popup BrowserWindow for the Google consent screen,
 * captures the authorization code via redirect, and exchanges
 * it for an ID token which is then sent to the POTACAT Cloud API.
 */
class CloudAuth {
  constructor(googleClientId) {
    this._clientId = googleClientId;
    // Local redirect server for capturing the OAuth code
    this._redirectPort = 48721;
    this._redirectUri = `http://localhost:${this._redirectPort}/callback`;
  }

  /**
   * Start the Google OAuth flow. Opens a browser window and returns
   * the authorization code on success.
   * @returns {Promise<string>} Google authorization code
   */
  googleSignIn() {
    return new Promise((resolve, reject) => {
      let server;
      let authWindow;

      // Start a local server to capture the redirect
      server = http.createServer((req, res) => {
        const parsed = url.parse(req.url, true);
        if (parsed.pathname === '/callback') {
          const code = parsed.query.code;
          const error = parsed.query.error;

          res.writeHead(200, { 'Content-Type': 'text/html' });
          if (code) {
            res.end('<html><body><h2>Signed in to POTACAT Cloud!</h2><p>You can close this window.</p><script>window.close()</script></body></html>');
          } else {
            res.end(`<html><body><h2>Sign-in failed</h2><p>${error || 'Unknown error'}</p></body></html>`);
          }

          // Cleanup
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
          }
          server.close();

          if (code) {
            resolve(code);
          } else {
            reject(new Error(error || 'OAuth cancelled'));
          }
        }
      });

      server.listen(this._redirectPort, '127.0.0.1', () => {
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
          new URLSearchParams({
            client_id: this._clientId,
            redirect_uri: this._redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'offline',
            prompt: 'select_account',
          }).toString();

        authWindow = new BrowserWindow({
          width: 500,
          height: 700,
          show: true,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        authWindow.loadURL(authUrl);

        authWindow.on('closed', () => {
          authWindow = null;
          server.close();
          // If we haven't resolved yet, reject
          reject(new Error('Window closed before completing sign-in'));
        });
      });

      server.on('error', (err) => {
        reject(new Error(`OAuth server error: ${err.message}`));
      });
    });
  }

  /**
   * Exchange an authorization code for tokens via the POTACAT Cloud API.
   * The API server handles the actual Google token exchange.
   *
   * @param {string} apiBaseUrl - e.g. "https://api.potacat.com"
   * @param {string} code - Google authorization code
   * @param {string} deviceId - This device's UUID
   * @returns {Promise<object>} { accessToken, refreshToken, user }
   */
  exchangeCodeForTokens(apiBaseUrl, code, deviceId) {
    return new Promise((resolve, reject) => {
      // First exchange code for Google ID token locally
      this._exchangeGoogleCode(code).then((idToken) => {
        const body = JSON.stringify({ idToken, deviceId });
        const parsed = new URL(`${apiBaseUrl}/v1/auth/google`);

        const options = {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        };

        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (res.statusCode === 200 || res.statusCode === 201) {
                resolve(result);
              } else {
                reject(new Error(result.error || `Auth failed: ${res.statusCode}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      }).catch(reject);
    });
  }

  /**
   * Exchange a Google authorization code for an ID token.
   * Note: For a desktop app, this requires a client secret. In production,
   * the server should handle the code exchange. For simplicity, we send the
   * code directly to our API which does the exchange.
   */
  _exchangeGoogleCode(code) {
    // For Electron desktop apps, Google's recommended approach is to use
    // the "loopback" redirect and send the code to your backend.
    // Our /v1/auth/google endpoint accepts both idToken and code.
    // Return the code as-is; the server will handle the exchange.
    return Promise.resolve(code);
  }
}

module.exports = CloudAuth;
