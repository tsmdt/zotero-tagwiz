import { assert } from "chai";
import { convertCase } from "../../src/core/caseStyles";
import type { CaseStyle } from "../../src/core/types";

function c(name: string, style: CaseStyle, extra = {}) {
  return convertCase(name, { style, ...extra });
}

describe("convertCase", function () {
  it("lower / upper", function () {
    assert.equal(c("Machine Learning", "lower"), "machine learning");
    assert.equal(c("Machine Learning", "upper"), "MACHINE LEARNING");
  });

  it("title case keeps small words lowercase except first", function () {
    assert.equal(c("the art of war", "title"), "The Art of War");
    assert.equal(c("of mice and men", "title"), "Of Mice and Men");
  });

  it("title/sentence keep acronyms by default, optionally not", function () {
    assert.equal(c("NLP methods", "title"), "NLP Methods");
    assert.equal(
      c("NLP methods", "title", { keepAcronyms: false }),
      "Nlp Methods",
    );
    assert.equal(c("deep LEARNING", "sentence"), "Deep LEARNING");
    assert.equal(
      c("deep LEARNING", "sentence", { keepAcronyms: false }),
      "Deep learning",
    );
  });

  it("sentence case", function () {
    assert.equal(
      c("MACHINE LEARNING basics", "sentence", { keepAcronyms: false }),
      "Machine learning basics",
    );
    assert.equal(c("machine Learning", "sentence"), "Machine learning");
  });

  it("camel / pascal / snake / kebab from mixed input", function () {
    assert.equal(c("machine learning", "camel"), "machineLearning");
    assert.equal(
      c("machine_learning-models", "pascal"),
      "MachineLearningModels",
    );
    assert.equal(c("machineLearning", "snake"), "machine_learning");
    assert.equal(c("Machine Learning", "kebab"), "machine-learning");
    assert.equal(
      c("HTTPServer error", "snake", { keepAcronyms: false }),
      "http_server_error",
    );
  });

  it("keeps acronyms in every style by default, optionally not", function () {
    const name = "LLM Framework Studies";
    assert.equal(c("AA Digital Humanities", "lower"), "AA digital humanities");
    assert.equal(c(name, "camel"), "LLMframeworkStudies");
    assert.equal(c(name, "pascal"), "LLMFrameworkStudies");
    assert.equal(c(name, "snake"), "LLM_framework_studies");
    assert.equal(c(name, "kebab"), "LLM-framework-studies");
    assert.equal(c("deep NLP models", "camel"), "deepNLPModels");
    assert.equal(c("HTTPServer error", "snake"), "HTTP_server_error");
    const off = { keepAcronyms: false };
    assert.equal(
      c("AA Digital Humanities", "lower", off),
      "aa digital humanities",
    );
    assert.equal(c(name, "camel", off), "llmFrameworkStudies");
    assert.equal(c(name, "pascal", off), "LlmFrameworkStudies");
    assert.equal(c(name, "snake", off), "llm_framework_studies");
  });

  it("keeps mixed-case words by default, optionally not", function () {
    assert.equal(c("iPhone apps", "title"), "iPhone Apps");
    assert.equal(c("McDonald's history", "title"), "McDonald's History");
    assert.equal(c("the LaTeX guide", "title"), "The LaTeX Guide");
    assert.equal(c("iPhone Apps", "sentence"), "iPhone apps");
    assert.equal(c("NaCl Solutions", "lower"), "NaCl solutions");
    assert.equal(
      c("iPhone apps", "title", { keepAcronyms: false }),
      "Iphone Apps",
    );
    // Only a capital after the first letter counts, not a capitalized word.
    assert.equal(c("Machine Learning", "lower"), "machine learning");
  });

  it("keeps punctuation other than separators in identifier styles", function () {
    assert.equal(c("C++ programming", "snake"), "c++_programming");
    assert.equal(c("C# basics", "kebab"), "c#-basics");
    assert.equal(c("C++ programming", "camel"), "c++Programming");
    assert.equal(c("C++ programming", "pascal"), "C++Programming");
    assert.equal(c("COVID-19 vaccines", "snake"), "COVID_19_vaccines");
    assert.equal(c("R&D funding", "kebab"), "R&D-funding");
    assert.notEqual(c("C++ programming", "snake"), c("C programming", "snake"));
  });

  it("handles non-Latin scripts and diacritics", function () {
    assert.equal(c("機械学習", "title"), "機械学習");
    assert.equal(c("école normale", "title"), "École Normale");
    assert.equal(c("ÉCOLE", "lower", { keepAcronyms: false }), "école");
  });

  it("is locale independent (Turkish dotted I)", function () {
    assert.equal(c("TITLE", "lower", { keepAcronyms: false }), "title");
    assert.notInclude(c("TITLE", "lower", { keepAcronyms: false }), "ı");
    // İ -> plain i, not i + combining dot above (U+0307).
    assert.equal(c("İstanbul Studies", "lower"), "istanbul studies");
    assert.equal(
      c("Visit İzmir", "sentence", { keepAcronyms: false }),
      "Visit izmir",
    );
    assert.equal(c("İstanbul Studies", "snake"), "istanbul_studies");
  });

  it("keeps a leading or trailing '_' / '-' in identifier styles", function () {
    const cases: Array<[string, CaseStyle, string]> = [
      ["_todo", "snake", "_todo"],
      ["_todo", "kebab", "_todo"],
      ["_todo", "camel", "_todo"],
      ["_todo", "pascal", "_Todo"],
      ["_to read", "snake", "_to_read"],
      ["_to read", "kebab", "_to-read"],
      ["_to read", "camel", "_toRead"],
      ["_to read", "pascal", "_ToRead"],
      ["__inbox", "snake", "__inbox"],
      ["-reviewed", "kebab", "-reviewed"],
      ["_fooBar", "camel", "_fooBar"],
      ["draft_", "pascal", "Draft_"],
    ];
    for (const [name, style, expected] of cases) {
      assert.equal(c(name, style), expected, `${style}: ${name}`);
    }
  });

  it("does not count words of symbols only as the first camel word", function () {
    assert.equal(c("# to read", "camel"), "#toRead");
    assert.equal(c("# to read", "pascal"), "#ToRead");
    assert.equal(c("+ deep learning", "camel"), "+deepLearning");
    assert.equal(c("#toread", "pascal"), "#Toread");
    // Digits still do, like in other camelCase converters.
    assert.equal(c("1 important thing", "camel"), "1ImportantThing");
  });

  it("keeps a user-given prefix unchanged", function () {
    assert.equal(
      c("00_Digital Humanities", "camel", { prefix: "00_" }),
      "00_digitalHumanities",
    );
    assert.equal(
      c("Aa-Computational-Studies", "kebab", { prefix: "Aa-" }),
      "Aa-computational-studies",
    );
    assert.equal(
      c("TECH: 2026 deep learning", "camel", { prefix: "TECH: " }),
      "TECH: 2026DeepLearning",
    );
    assert.equal(
      c("topic:machine learning", "upper", { prefix: "topic:" }),
      "topic:MACHINE LEARNING",
    );
  });

  it("converts the whole tag when the prefix does not match exactly", function () {
    assert.equal(
      c("tech: deep learning", "camel", { prefix: "TECH: " }),
      "tech:DeepLearning",
    );
    assert.equal(c("Deep Learning", "lower", { prefix: "" }), "deep learning");
    assert.equal(c("topic:machine", "upper"), "TOPIC:MACHINE");
  });

  it("is idempotent with a prefix", function () {
    const opts = { prefix: "TECH: " };
    const once = c("TECH: 2026 deep learning", "camel", opts);
    assert.equal(c(once, "camel", opts), once);
  });

  it("is idempotent for every style", function () {
    const styles: CaseStyle[] = [
      "lower",
      "upper",
      "title",
      "sentence",
      "camel",
      "pascal",
      "snake",
      "kebab",
    ];
    for (const style of styles) {
      for (const name of [
        "Machine learning",
        "NLP and the web",
        "LLM Framework Studies",
        "deep NLP models",
        "a_b-c d",
        "x",
        "iPhone apps",
        "McDonald's history",
        "C++ programming",
        "R&D funding",
        "_todo",
        "_to read",
        "-reviewed",
        "# to read",
        "+ deep learning",
        "! urgent stuff",
        "#toread",
        "1 important thing",
        "İstanbul Studies",
      ]) {
        for (const keepAcronyms of [true, false]) {
          const once = c(name, style, { keepAcronyms });
          assert.equal(
            c(once, style, { keepAcronyms }),
            once,
            `${style} (keepAcronyms=${keepAcronyms}): ${name}`,
          );
        }
      }
    }
  });

  it("returns empty string for separator-only identifiers", function () {
    assert.equal(c("---", "camel"), "");
    assert.equal(c("   ", "title"), "");
  });

  it("normalizes to NFC and trims", function () {
    assert.equal(c("  école  ", "lower"), "école");
  });
});
