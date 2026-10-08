package lib.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Verifies the signed download links the storage service hands out. */
public final class TokenVerifier {
  private final byte[] secret;

  public TokenVerifier(byte[] secret) {
    this.secret = secret.clone();
  }

  /** A link is honoured only when its signature is ours and it has not expired. */
  public boolean isValid(String objectId, long expiresAtEpochSeconds, String signature, Instant now) {
    if (signature == null || signature.isEmpty()) {
      return false;
    }
    if (now.getEpochSecond() >= expiresAtEpochSeconds) {
      return false;
    }
    byte[] expected = sign(objectId + ":" + expiresAtEpochSeconds);
    byte[] given;
    try {
      given = Base64.getUrlDecoder().decode(signature);
    } catch (IllegalArgumentException malformed) {
      return false;
    }
    return MessageDigest.isEqual(expected, given);
  }

  private byte[] sign(String message) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret, "HmacSHA256"));
      return mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
    } catch (java.security.GeneralSecurityException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
