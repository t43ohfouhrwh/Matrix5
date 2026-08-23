const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CHANGE THIS SECRET KEY to anything long and random (keep it private)
const SECRET_KEY = process.env.MATRIX_KEY || 'MatrixSecretKeyChangeMeImmediately123!';

function encryptUrl(url) {
  return encodeURIComponent(CryptoJS.AES.encrypt(url, SECRET_KEY).toString());
}

function decryptUrl(encrypted) {
  try {
    const bytes = CryptoJS.AES.decrypt(decodeURIComponent(encrypted), SECRET_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    return null;
  }
}

function rewriteUrl(original, base) {
  try {
    const absolute = new URL(original, base).href;
    return '/p/' + encryptUrl(absolute);
  } catch {
    return original;
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Main proxy route – encrypted URLs live here
app.get('/p/:enc', async (req, res) => {
  const target = decryptUrl(req.params.enc);
  if (!target || !target.startsWith('http')) {
    return res.status(400).send('Invalid or expired encrypted URL');
  }

  try {
    const response = await axios.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      validateStatus: () => true
    });

    const contentType = response.headers['content-type'] || '';

    // Non-HTML (images, css, js, fonts) – just pipe through
    if (!contentType.includes('text/html')) {
      res.set(response.headers);
      return res.send(response.data);
    }

    const html = response.data.toString('utf8');
    const $ = cheerio.load(html);

    // Rewrite every possible URL so they stay inside the proxy
    $('a[href], link[href], script[src], img[src], iframe[src], form[action], source[src], video[src], audio[src]').each((i, el) => {
      const $el = $(el);
      ['href', 'src', 'action'].forEach(attr => {
        const val = $el.attr(attr);
        if (val && !val.startsWith('data:') && !val.startsWith('javascript:') && !val.startsWith('#')) {
          $el.attr(attr, rewriteUrl(val, target));
        }
      });
    });

    // Also rewrite srcset
    $('[srcset]').each((i, el) => {
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const rewritten = srcset.split(',').map(part => {
          const [url, size] = part.trim().split(/\s+/);
          return rewriteUrl(url, target) + (size ? ' ' + size : '');
        }).join(', ');
        $(el).attr('srcset', rewritten);
      }
    });

    // Inject a tiny script so forms and some JS navigation stay proxied
    $('head').prepend(`
      <base href="${target}">
      <script>
        (function() {
          const origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(m, u) {
            if (u && !u.startsWith('/p/')) {
              try { u = '/p/' + btoa(unescape(encodeURIComponent(u))); } catch(e) {}
            }
            return origOpen.apply(this, arguments);
          };
        })();
      </script>
    `);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());
  } catch (err) {
    res.status(502).send('Proxy error: could not fetch the page. Try another URL.');
  }
});

// API used by the frontend address bar
app.post('/encrypt', (req, res) => {
  let url = (req.body.url || '').trim();
  if (!url) return res.json({ error: 'No URL' });
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  res.json({ encrypted: encryptUrl(url) });
});

app.listen(PORT, () => {
  console.log('Matrix proxy running on port ' + PORT);
});
