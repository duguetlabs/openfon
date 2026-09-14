/** Only the optional media subprotocol is supported. null means no offer;
 * false means a present malformed/unsupported offer. Do not reflect raw input. */
export function selectAsteriskProtocol(offer: string | null | undefined): 'media' | null | false {
  if (offer == null) return null;
  const protocols = offer.split(',').map(value => value.replace(/^[ \t]+|[ \t]+$/g, ''));
  // Reject any non-token byte, including a final newline (JS $ allows one).
  const invalidToken = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;
  if (protocols.some(value => !value || invalidToken.test(value)) || new Set(protocols).size !== protocols.length) return false;
  return protocols.includes('media') ? 'media' : false;
}
