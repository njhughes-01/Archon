package lib.text;

import java.util.ArrayList;
import java.util.List;

/** Splits a search query into lower-cased word tokens, keeping quoted phrases whole. */
public final class Tokenizer {
  private Tokenizer() {}

  public static List<String> tokens(String query) {
    List<String> out = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    boolean quoted = false;
    for (char c : query.toCharArray()) {
      if (c == '"') {
        quoted = !quoted;
        flush(current, out);
      } else if (Character.isWhitespace(c) && !quoted) {
        flush(current, out);
      } else {
        current.append(Character.toLowerCase(c));
      }
    }
    flush(current, out);
    return out;
  }

  private static void flush(StringBuilder current, List<String> out) {
    if (current.length() > 0) {
      out.add(current.toString());
      current.setLength(0);
    }
  }
}
