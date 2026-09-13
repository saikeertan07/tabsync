/**
 * TabSync Studio - TLS Certificate & Host Identity Management
 * Provides authenticated encryption and certificate fingerprinting for local network security.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * Normalizes a SHA-256 fingerprint string (e.g. "AA:BB:CC:..." or "aabbcc...")
 * into lowercase hexadecimal without colons for consistent comparisons.
 */
function normalizeFingerprint(fp) {
  if (typeof fp !== 'string') return '';
  return fp.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

/**
 * Formats a raw hex fingerprint into standard colon-separated uppercase representation
 * (e.g. "SHA256:AA:BB:CC:...")
 */
function formatFingerprint(hexOrColon) {
  const clean = normalizeFingerprint(hexOrColon);
  if (!clean || clean.length !== 64) return hexOrColon || '';
  const parts = [];
  for (let i = 0; i < clean.length; i += 2) {
    parts.push(clean.substr(i, 2).toUpperCase());
  }
  return parts.join(':');
}

/**
 * Generates or loads the persistent host TLS keypair and self-signed X.509 certificate.
 * Includes Subject Alternative Names (SANs) for localhost, loopback IPs, hostname, and all local IPs.
 */
function getOrCreateTlsCertificate(configDir, hostIps = []) {
  const tlsDir = path.join(configDir, 'tls');
  fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });

  const keyPath = path.join(tlsDir, 'key.pem');
  const certPath = path.join(tlsDir, 'cert.pem');

  let certPem = null;
  let keyPem = null;

  // 1. Check if existing certificate exists and is valid
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const existingCert = fs.readFileSync(certPath, 'utf8');
      const existingKey = fs.readFileSync(keyPath, 'utf8');
      const x509 = new crypto.X509Certificate(existingCert);

      // Verify certificate is not expired (has at least 48 hours remaining)
      const validTo = new Date(x509.validTo).getTime();
      if (validTo > Date.now() + (48 * 60 * 60 * 1000)) {
        certPem = existingCert;
        keyPem = existingKey;
      }
    } catch (e) {
      console.warn('[TLS] Existing certificate invalid or unreadable, regenerating:', e.message);
    }
  }

  // 2. Generate new certificate if missing or expired
  if (!certPem || !keyPem) {
    const sanSet = new Set(['DNS:localhost', 'IP:127.0.0.1', 'IP:::1']);
    const hostname = os.hostname();
    if (hostname) {
      sanSet.add(`DNS:${hostname}`);
      if (!hostname.endsWith('.local')) {
        sanSet.add(`DNS:${hostname}.local`);
      }
    }

    if (Array.isArray(hostIps)) {
      for (const ip of hostIps) {
        if (typeof ip === 'string' && ip.trim()) {
          sanSet.add(`IP:${ip.trim()}`);
        }
      }
    }

    const sanString = Array.from(sanSet).join(',');
    const opensslBin = findOpenSsl();
    const cmd = `${opensslBin} req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 825 -subj "/CN=TabSync Studio Mac Host (${hostname || 'Mac'})" -addext "subjectAltName=${sanString}"`;

    try {
      execSync(cmd, { stdio: 'pipe' });
      fs.chmodSync(keyPath, 0o600);
      fs.chmodSync(certPath, 0o644);
      certPem = fs.readFileSync(certPath, 'utf8');
      keyPem = fs.readFileSync(keyPath, 'utf8');
      console.log('[TLS] Generated fresh host TLS certificate with SANs:', sanString);
    } catch (err) {
      console.error('[TLS] Failed to generate TLS certificate via OpenSSL:', err.message);
      throw new Error(`TLS certificate generation failed: ${err.message}`);
    }
  }

  const x509 = new crypto.X509Certificate(certPem);
  const fingerprint = x509.fingerprint256;
  const fingerprintHex = normalizeFingerprint(fingerprint);

  return {
    key: keyPem,
    cert: certPem,
    fingerprint: fingerprint,
    fingerprintHex: fingerprintHex,
    validTo: x509.validTo,
    subjectAltName: x509.subjectAltName
  };
}

function findOpenSsl() {
  const candidates = [
    '/opt/anaconda3/bin/openssl',
    '/usr/bin/openssl',
    '/opt/homebrew/bin/openssl',
    '/usr/local/bin/openssl'
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return 'openssl';
}

module.exports = {
  getOrCreateTlsCertificate,
  normalizeFingerprint,
  formatFingerprint
};
