import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveSigningKey, hmacSha256, presign, uriEncode } from './sigv4.js';

/**
 * SigV4, pinned to AWS's own published vectors.
 *
 * This file is the justification for not depending on the AWS SDK. Hand-written
 * signing is fine exactly as long as it is checked against the specification's
 * numbers rather than against itself, so two of these three tests reproduce
 * values printed in AWS's documentation and the third reproduces the canonical
 * request from the presigned-S3 example verbatim.
 *
 * Canonicalization is where the bugs are — encoding, ordering, the trailing
 * newline after the headers block — so the canonical request is asserted as a
 * whole string rather than probed field by field.
 */

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

describe('the signing key derivation', () => {
  // AWS General Reference, "Examples of how to derive a version 4 signing key".
  it('reproduces the documented derivation for iam/us-east-1/20150830', () => {
    const key = deriveSigningKey(AWS_SECRET, '20150830', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });
});

describe('the full HMAC chain', () => {
  /*
   * `get-vanilla` from the AWS4 signature test suite, end to end.
   *
   * Header-signed rather than presigned, so it goes through the primitives
   * rather than through `presign` — which is the point: it proves the chain and
   * the string-to-sign layout independently of how the query string is built.
   */
  it('reproduces get-vanilla', () => {
    const canonicalRequest = [
      'GET',
      '/',
      '',
      'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n',
      'host;x-amz-date',
      createHash('sha256').update('').digest('hex'),
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/service/aws4_request',
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const signature = hmacSha256(
      deriveSigningKey(AWS_SECRET, '20150830', 'us-east-1', 'service'),
      stringToSign,
    ).toString('hex');

    expect(signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });
});

describe('presigning', () => {
  const documented = () =>
    presign({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: AWS_SECRET },
      expiresInSeconds: 86_400,
      now: new Date('2013-05-24T00:00:00Z'),
    });

  /*
   * The canonical request from AWS's "Authenticating Requests: Using Query
   * Parameters" S3 example, character for character.
   *
   * Asserted rather than the signature, because the signature is
   * `HMAC(key, sha256(this))` and the chain producing it is already pinned
   * above by two independent vectors. If this string is right and those two
   * pass, the signature is right — and if this string drifts, the diff says
   * exactly which part of canonicalization broke, which a hex digest never does.
   */
  it('builds the documented canonical request for a presigned S3 GET', () => {
    expect(documented().canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        'host:examplebucket.s3.amazonaws.com',
        '',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    );
  });

  it('is deterministic for the same instant and changes with it', () => {
    expect(documented().signature).toBe(documented().signature);
    const later = presign({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: AWS_SECRET },
      expiresInSeconds: 86_400,
      now: new Date('2013-05-24T00:00:01Z'),
    });
    expect(later.signature).not.toBe(documented().signature);
  });

  it('signs content-type when one is given, so a ticket cannot be reused for HTML', () => {
    const image = presign({
      method: 'PUT',
      host: 'acct.r2.cloudflarestorage.com',
      path: '/bucket/public/a.webp',
      region: 'auto',
      service: 's3',
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      expiresInSeconds: 300,
      headers: { 'content-type': 'image/webp' },
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const html = presign({
      method: 'PUT',
      host: 'acct.r2.cloudflarestorage.com',
      path: '/bucket/public/a.webp',
      region: 'auto',
      service: 's3',
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      expiresInSeconds: 300,
      headers: { 'content-type': 'text/html' },
      now: new Date('2026-01-01T00:00:00Z'),
    });

    expect(image.canonicalRequest).toContain('content-type:image/webp');
    expect(image.signature).not.toBe(html.signature);
  });

  it('reports the expiry instant the URL claims', () => {
    const signed = presign({
      method: 'GET',
      host: 'acct.r2.cloudflarestorage.com',
      path: '/bucket/private/a.pdf',
      region: 'auto',
      service: 's3',
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      expiresInSeconds: 120,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(signed.expiresAt.toISOString()).toBe('2026-01-01T00:02:00.000Z');
    expect(signed.url).toContain('X-Amz-Expires=120');
  });
});

describe('RFC 3986 encoding', () => {
  /*
   * `encodeURIComponent` leaves these six alone and SigV4 does not. A key with
   * a bracket in it would sign one string and be requested as another, which is
   * a 403 that only ever happens for some filenames — the worst kind of bug to
   * find in production.
   */
  it("encodes !'()* which encodeURIComponent leaves alone", () => {
    expect(uriEncode("!'()*", true)).toBe('%21%27%28%29%2A');
    expect(encodeURIComponent("!'()*")).toBe("!'()*");
  });

  it('encodes a slash only when asked, so a path keeps its structure', () => {
    expect(uriEncode('a/b', false)).toBe('a/b');
    expect(uriEncode('a/b', true)).toBe('a%2Fb');
  });

  it('encodes multi-byte characters per UTF-8 byte', () => {
    // A Bangla filename is not hypothetical here (§24: customer-facing is bn).
    expect(uriEncode('চ', true)).toBe('%E0%A6%9A');
  });
});
