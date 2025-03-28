import { Router, type Request, type Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import debugLib from 'debug';
import NodeCache from 'node-cache';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const debug = debugLib('proxy:debug');
const cache = new NodeCache({ stdTTL: 14400 });

const SECRET_KEY = process.env.SECRET_KEY || 'update-this-secret';

/** 
 * generateSignedUrl 
 * - Creates a signature for a resourceId
 * - Adds an expiration time (UNIX timestamp, 4 hours from now)
 * - Returns a local endpoint: /segment/resource?resourceId=xxx&sig=yyy&exp=zzz
 */
function generateSignedUrl(resourceId: string, type: 'segment'): string {
  const exp = Math.floor(Date.now() / 1000) + 14400; // 14400 seconds = 4 hours
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${resourceId}${exp}${type}`)
    .digest('hex');

  return `/fetch/segment/resource?resourceId=${resourceId}&sig=${signature}&exp=${exp}`;
}

/**
 * verifySignedUrl
 * - Checks if the signature matches
 * - Checks if the expiration hasn't passed
 */
function verifySignedUrl(
  resourceId: string,
  sig: string,
  exp: string,
  type: 'segment'
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (parseInt(exp, 10) < now) {
    return false;
  }

  const expectedSig = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${resourceId}${exp}${type}`)
    .digest('hex');

  return sig === expectedSig;
}

/**
 * GET /
 * - Example route for fetching a remote M3U8
 *   based on ?url=<some-remote-m3u8>.
 * - Rewrites all lines that do *not* start with '#' (resources) to a signed local URL.
 * - Ref parameter is optional and can be used to set the Referer header.
 */
router.get('/', async (req: Request, res: Response) => {
  const { url, ref } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'No URL provided' });
  }

  try {
    debug(`Fetching M3U8 file from: ${url}`);

    const headers: Record<string, string> = {};
    if (ref && typeof ref === 'string') {
      headers['Referer'] = ref;
    }

    const response = await axios.get(url, { responseType: 'text', headers });

    let m3u8Content = response.data as string;

    if (!m3u8Content.startsWith('#EXTM3U')) {
      debug('Not a valid M3U8 (no #EXTM3U at start), returning raw content');
      return res.type('text/plain').send(m3u8Content);
    }

    const lines = m3u8Content.split('\n');

    const transformed = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return line;
      }

      const resourceId = uuidv4();

      const absoluteUrl = new URL(trimmed, url).href;

      cache.set(resourceId, absoluteUrl);

      const signedUrl = generateSignedUrl(resourceId, 'segment');
      debug(`Rewriting line: "${trimmed}" -> "${signedUrl}"`);
      return signedUrl;
    });

    const newM3U8 = transformed.join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(newM3U8);
    debug('Rewritten M3U8 sent to client');
  } catch (error) {
    debug(`Failed to proxy M3U8. Error: ${(error as Error).message}`);
    res.status(500).json({ error: 'Failed to fetch M3U8 content' });
  }
});

/**
 * GET /segment/resource
 * - The player will request this route whenever it sees
 *   a line in the M3U8 like "/segment/resource?resourceId=xx&sig=yyy&exp=zzz"
 */
router.get('/segment/resource', async (req: Request, res: Response) => {
  const { resourceId, sig, exp } = req.query;

  if (!resourceId || !sig || !exp) {
    return res.status(400).json({ error: 'Missing signed URL params' });
  }

  if (!verifySignedUrl(resourceId as string, sig as string, exp as string, 'segment')) {
    return res.status(400).json({ error: 'Invalid or expired signed URL' });
  }

  const realUrl = cache.get<string>(resourceId as string);
  if (!realUrl) {
    return res.status(404).json({ error: 'Resource not found or expired' });
  }

  try {
    debug(`Fetching actual resource from: ${realUrl}`);

    const segmentResp = await axios.get(realUrl, { responseType: 'arraybuffer' });

    let contentType = segmentResp.headers['content-type'];
    if (!contentType) {
      contentType = 'application/octet-stream';
    }

    res.setHeader('Content-Type', contentType);
    res.send(segmentResp.data);
    debug('Segment served successfully');
  } catch (error) {
    debug(`Failed to fetch resource: ${(error as Error).message}`);
    res.status(500).json({ error: 'Error fetching segment content' });
  }
});

router.get('/image', async (req: Request, res: Response) => {
    const { url, ref } = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'No URL provided' });
    }

    try {
        debug(`Fetching image from: ${url}`);

        const headers: Record<string, string> = {};
        if (ref && typeof ref === 'string') {
            headers['Referer'] = ref;
        }

        const response = await axios.get(url, { responseType: 'arraybuffer', headers });

        const contentType = response.headers['content-type'];
        res.setHeader('Content-Type', contentType);
        res.send(response.data);
        debug('Image served successfully');
    } catch (error) {
        debug(`Failed to fetch image: ${(error as Error).message}`);
        res.status(500).json({ error: 'Error fetching image content' });
    }
});

export default router;