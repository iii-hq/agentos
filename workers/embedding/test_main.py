import asyncio
import math
import sys
import os
from unittest.mock import patch, MagicMock


mock_iii_module = MagicMock()
mock_iii_instance = MagicMock()
mock_iii_instance.worker_name = "embedding"


def _passthrough_decorator(**kwargs):
    def wrapper(fn):
        return fn
    return wrapper


mock_iii_instance.function = _passthrough_decorator
mock_iii_module.III.return_value = mock_iii_instance
sys.modules["iii_sdk"] = mock_iii_module

import main as mod

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_model():
    mod.model = None
    yield
    mod.model = None


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ===========================================================================
# get_model tests
# ===========================================================================

class TestGetModel:
    def test_returns_fallback_when_sentence_transformers_missing(self):
        with patch.dict(sys.modules, {"sentence_transformers": None}):
            mod.model = None
            result = mod.get_model()
        assert result == "fallback"

    def test_caches_model_on_second_call(self):
        mod.model = None
        first = mod.get_model()
        second = mod.get_model()
        assert first is second

    def test_respects_embedding_model_env_var(self):
        fake_st = MagicMock()
        fake_class = MagicMock(return_value="custom-model-instance")
        fake_st.SentenceTransformer = fake_class
        with patch.dict(sys.modules, {"sentence_transformers": fake_st}):
            with patch.dict(os.environ, {"EMBEDDING_MODEL": "my-custom-model"}):
                mod.model = None
                result = mod.get_model()
        fake_class.assert_called_once_with("my-custom-model")
        assert result == "custom-model-instance"

    def test_uses_default_model_when_env_var_unset(self):
        fake_st = MagicMock()
        fake_class = MagicMock(return_value="default-instance")
        fake_st.SentenceTransformer = fake_class
        with patch.dict(sys.modules, {"sentence_transformers": fake_st}):
            env = os.environ.copy()
            env.pop("EMBEDDING_MODEL", None)
            with patch.dict(os.environ, env, clear=True):
                mod.model = None
                mod.get_model()
        fake_class.assert_called_once_with("all-MiniLM-L6-v2")

    def test_returns_string_fallback_type(self):
        result = mod.get_model()
        assert isinstance(result, str)
        assert result == "fallback"


# ===========================================================================
# generate_embedding tests (fallback model)
# ===========================================================================

class TestGenerateEmbeddingFallback:
    def test_single_text_returns_embedding_and_dim(self):
        result = _run(mod.generate_embedding({"text": "hello world"}))
        assert "embedding" in result
        assert result["dim"] == 128
        assert len(result["embedding"]) == 128

    def test_single_text_embedding_values_are_floats(self):
        result = _run(mod.generate_embedding({"text": "test"}))
        assert all(isinstance(v, float) for v in result["embedding"])

    def test_empty_text_returns_valid_embedding(self):
        result = _run(mod.generate_embedding({"text": ""}))
        assert "embedding" in result
        assert result["dim"] == 128
        assert len(result["embedding"]) == 128

    def test_batch_mode_returns_embeddings_and_dim(self):
        result = _run(mod.generate_embedding({"batch": ["hello", "world"]}))
        assert "embeddings" in result
        assert result["dim"] == 128
        assert len(result["embeddings"]) == 2
        for emb in result["embeddings"]:
            assert len(emb) == 128

    def test_batch_with_single_item(self):
        result = _run(mod.generate_embedding({"batch": ["only one"]}))
        assert "embeddings" in result
        assert len(result["embeddings"]) == 1
        assert len(result["embeddings"][0]) == 128

    def test_batch_with_empty_list_returns_single_mode(self):
        result = _run(mod.generate_embedding({"batch": []}))
        assert "embedding" in result
        assert result["dim"] == 128

    def test_very_long_text(self):
        long_text = "word " * 2000
        result = _run(mod.generate_embedding({"text": long_text}))
        assert len(result["embedding"]) == 128
        assert result["dim"] == 128

    def test_unicode_text_emoji(self):
        result = _run(mod.generate_embedding({"text": "hello 🌍🎉 world"}))
        assert len(result["embedding"]) == 128

    def test_unicode_text_cjk(self):
        result = _run(mod.generate_embedding({"text": "你好世界 テスト 테스트"}))
        assert len(result["embedding"]) == 128

    def test_unicode_text_arabic(self):
        result = _run(mod.generate_embedding({"text": "مرحبا بالعالم"}))
        assert len(result["embedding"]) == 128

    def test_special_characters(self):
        result = _run(mod.generate_embedding({"text": "!@#$%^&*()_+-=[]{}|;':\",./<>?"}))
        assert len(result["embedding"]) == 128

    def test_missing_text_key_defaults_to_empty(self):
        result = _run(mod.generate_embedding({}))
        expected = mod._hash_embed("")
        assert result["embedding"] == expected
        assert result["dim"] == 128

    def test_missing_batch_key_uses_single_text_mode(self):
        result = _run(mod.generate_embedding({"text": "single"}))
        assert "embedding" in result
        assert "embeddings" not in result

    def test_batch_takes_priority_over_text(self):
        result = _run(mod.generate_embedding({"text": "ignored", "batch": ["used"]}))
        assert "embeddings" in result
        assert "embedding" not in result

    def test_different_texts_produce_different_embeddings(self):
        r1 = _run(mod.generate_embedding({"text": "alpha"}))
        r2 = _run(mod.generate_embedding({"text": "beta"}))
        assert r1["embedding"] != r2["embedding"]

    def test_same_text_produces_same_embedding(self):
        r1 = _run(mod.generate_embedding({"text": "consistent"}))
        r2 = _run(mod.generate_embedding({"text": "consistent"}))
        assert r1["embedding"] == r2["embedding"]

    def test_newlines_in_text(self):
        result = _run(mod.generate_embedding({"text": "line1\nline2\nline3"}))
        assert len(result["embedding"]) == 128

    def test_tabs_and_mixed_whitespace(self):
        result = _run(mod.generate_embedding({"text": "col1\tcol2\t\tcol3"}))
        assert len(result["embedding"]) == 128


# ===========================================================================
# compute_similarity tests
# ===========================================================================

class TestComputeSimilarity:
    def test_identical_vectors_return_one(self):
        v = [1.0, 2.0, 3.0]
        result = _run(mod.compute_similarity({"a": v, "b": v}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 1.0

    def test_opposite_vectors_return_neg_one(self):
        a = [1.0, 0.0]
        b = [-1.0, 0.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == -1.0

    def test_orthogonal_vectors_return_zero(self):
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 0.0

    def test_different_length_vectors_return_zero(self):
        result = _run(mod.compute_similarity({"a": [1.0, 2.0], "b": [1.0]}))
        assert result["similarity"] == 0.0

    def test_empty_vectors_return_zero(self):
        result = _run(mod.compute_similarity({"a": [], "b": []}))
        assert result["similarity"] == 0.0

    def test_single_element_vectors(self):
        result = _run(mod.compute_similarity({"a": [3.0], "b": [5.0]}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 1.0

    def test_single_element_opposite(self):
        result = _run(mod.compute_similarity({"a": [3.0], "b": [-5.0]}))
        assert pytest.approx(result["similarity"], abs=1e-9) == -1.0

    def test_large_vectors(self):
        a = [float(i) for i in range(1, 1001)]
        b = [float(i) for i in range(1001, 2001)]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert -1.0 <= result["similarity"] <= 1.0

    def test_zero_vector_returns_zero(self):
        result = _run(mod.compute_similarity({"a": [0.0, 0.0], "b": [1.0, 2.0]}))
        assert result["similarity"] == 0.0

    def test_both_zero_vectors_return_zero(self):
        result = _run(mod.compute_similarity({"a": [0.0, 0.0], "b": [0.0, 0.0]}))
        assert result["similarity"] == 0.0

    def test_proportional_vectors_return_one(self):
        a = [1.0, 2.0, 3.0]
        b = [2.0, 4.0, 6.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 1.0

    def test_negative_proportional_vectors(self):
        a = [-1.0, -2.0, -3.0]
        b = [-2.0, -4.0, -6.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 1.0

    def test_negative_non_proportional_vectors(self):
        a = [-1.0, -2.0, -3.0]
        b = [-4.0, -5.0, -6.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert 0.0 < result["similarity"] < 1.0

    def test_mixed_positive_negative(self):
        a = [1.0, -1.0]
        b = [-1.0, 1.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == -1.0

    def test_missing_a_defaults_empty(self):
        result = _run(mod.compute_similarity({"b": [1.0]}))
        assert result["similarity"] == 0.0

    def test_missing_b_defaults_empty(self):
        result = _run(mod.compute_similarity({"a": [1.0]}))
        assert result["similarity"] == 0.0

    def test_missing_both_defaults_empty(self):
        result = _run(mod.compute_similarity({}))
        assert result["similarity"] == 0.0

    def test_very_small_values(self):
        a = [1e-10, 2e-10]
        b = [3e-10, 4e-10]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert -1.0 <= result["similarity"] <= 1.0

    def test_very_large_values(self):
        a = [1e15, 2e15]
        b = [3e15, 4e15]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert -1.0 <= result["similarity"] <= 1.0


# ===========================================================================
# _hash_embed tests
# ===========================================================================

class TestHashEmbed:
    def test_returns_list_of_exact_dim(self):
        result = mod._hash_embed("hello world")
        assert isinstance(result, list)
        assert len(result) == 128

    def test_deterministic_same_text(self):
        a = mod._hash_embed("deterministic test")
        b = mod._hash_embed("deterministic test")
        assert a == b

    def test_different_text_gives_different_embedding(self):
        a = mod._hash_embed("cat")
        b = mod._hash_embed("dog")
        assert a != b

    def test_empty_text_returns_valid_vector(self):
        result = mod._hash_embed("")
        assert len(result) == 128
        assert all(v == 0.0 for v in result)

    def test_custom_dim_64(self):
        result = mod._hash_embed("test", dim=64)
        assert len(result) == 64

    def test_custom_dim_256(self):
        result = mod._hash_embed("test", dim=256)
        assert len(result) == 256

    def test_custom_dim_1(self):
        result = mod._hash_embed("test", dim=1)
        assert len(result) == 1

    def test_normalized_magnitude_close_to_one(self):
        result = mod._hash_embed("normalize me")
        magnitude = sum(v * v for v in result) ** 0.5
        assert pytest.approx(magnitude, abs=1e-9) == 1.0

    def test_single_word(self):
        result = mod._hash_embed("hello")
        assert len(result) == 128
        magnitude = sum(v * v for v in result) ** 0.5
        assert pytest.approx(magnitude, abs=1e-9) == 1.0

    def test_multi_word(self):
        result = mod._hash_embed("hello beautiful world")
        assert len(result) == 128
        magnitude = sum(v * v for v in result) ** 0.5
        assert pytest.approx(magnitude, abs=1e-9) == 1.0

    def test_very_long_text(self):
        long_text = " ".join(f"word{i}" for i in range(5000))
        result = mod._hash_embed(long_text)
        assert len(result) == 128
        magnitude = sum(v * v for v in result) ** 0.5
        assert pytest.approx(magnitude, abs=1e-9) == 1.0

    def test_whitespace_only_text(self):
        result = mod._hash_embed("   ")
        assert len(result) == 128
        assert all(v == 0.0 for v in result)

    def test_unicode_text(self):
        result = mod._hash_embed("hello 世界 🌍")
        assert len(result) == 128

    def test_all_values_are_floats(self):
        result = mod._hash_embed("type check")
        assert all(isinstance(v, float) for v in result)

    def test_case_insensitive_due_to_lower(self):
        a = mod._hash_embed("Hello World")
        b = mod._hash_embed("hello world")
        assert a == b

    def test_different_dim_different_length(self):
        a = mod._hash_embed("same text", dim=32)
        b = mod._hash_embed("same text", dim=64)
        assert len(a) == 32
        assert len(b) == 64

    def test_tab_separated_words(self):
        result = mod._hash_embed("word1\tword2")
        assert len(result) == 128

    def test_newline_separated_words(self):
        result = mod._hash_embed("word1\nword2")
        assert len(result) == 128

    def test_repeated_word(self):
        result = mod._hash_embed("repeat repeat repeat")
        assert len(result) == 128
        magnitude = sum(v * v for v in result) ** 0.5
        assert pytest.approx(magnitude, abs=1e-9) == 1.0


# ===========================================================================
# Integration tests
# ===========================================================================

class TestIntegration:
    def test_main_function_exists(self):
        assert asyncio.iscoroutinefunction(mod.main)

    def test_worker_name_is_embedding(self):
        assert mock_iii_instance.worker_name == "embedding"

    def test_generate_then_similarity_identical(self):
        r1 = _run(mod.generate_embedding({"text": "the cat sat"}))
        r2 = _run(mod.generate_embedding({"text": "the cat sat"}))
        sim = _run(mod.compute_similarity({"a": r1["embedding"], "b": r2["embedding"]}))
        assert pytest.approx(sim["similarity"], abs=1e-9) == 1.0

    def test_different_texts_lower_similarity(self):
        r1 = _run(mod.generate_embedding({"text": "machine learning"}))
        r2 = _run(mod.generate_embedding({"text": "quantum physics"}))
        sim = _run(mod.compute_similarity({"a": r1["embedding"], "b": r2["embedding"]}))
        assert sim["similarity"] < 1.0

    def test_batch_embeddings_pairwise_similarity(self):
        result = _run(mod.generate_embedding({"batch": ["hello", "hello"]}))
        sim = _run(mod.compute_similarity({
            "a": result["embeddings"][0],
            "b": result["embeddings"][1],
        }))
        assert pytest.approx(sim["similarity"], abs=1e-9) == 1.0

    def test_iii_instance_created(self):
        assert mod.iii is not None

    def test_generate_embedding_is_coroutine(self):
        assert asyncio.iscoroutinefunction(mod.generate_embedding)

    def test_compute_similarity_is_coroutine(self):
        assert asyncio.iscoroutinefunction(mod.compute_similarity)


# ===========================================================================
# TestGetModelEdgeCases
# ===========================================================================

class TestGetModelEdgeCases:
    def test_fallback_is_cached_across_calls(self):
        mod.model = None
        first = mod.get_model()
        second = mod.get_model()
        assert first == "fallback"
        assert first is second

    def test_model_none_triggers_loading(self):
        mod.model = None
        result = mod.get_model()
        assert result is not None

    def test_pre_set_model_is_returned(self):
        sentinel = object()
        mod.model = sentinel
        assert mod.get_model() is sentinel

    def test_model_with_empty_env_var(self):
        fake_st = MagicMock()
        fake_class = MagicMock(return_value="empty-env-instance")
        fake_st.SentenceTransformer = fake_class
        with patch.dict(sys.modules, {"sentence_transformers": fake_st}):
            with patch.dict(os.environ, {"EMBEDDING_MODEL": ""}):
                mod.model = None
                mod.get_model()
        fake_class.assert_called_once_with("")

    def test_model_with_whitespace_env_var(self):
        fake_st = MagicMock()
        fake_class = MagicMock(return_value="ws-instance")
        fake_st.SentenceTransformer = fake_class
        with patch.dict(sys.modules, {"sentence_transformers": fake_st}):
            with patch.dict(os.environ, {"EMBEDDING_MODEL": "  "}):
                mod.model = None
                mod.get_model()
        fake_class.assert_called_once_with("  ")

    def test_model_constructor_exception_falls_through(self):
        fake_st = MagicMock()
        fake_st.SentenceTransformer.side_effect = RuntimeError("download failed")
        with patch.dict(sys.modules, {"sentence_transformers": fake_st}):
            mod.model = None
            with pytest.raises(RuntimeError, match="download failed"):
                mod.get_model()

    def test_model_global_variable_starts_none(self):
        mod.model = None
        assert mod.model is None

    def test_multiple_calls_no_extra_imports(self):
        mod.model = None
        mod.get_model()
        mod.get_model()
        mod.get_model()
        assert mod.model == "fallback"

    def test_model_reassignment_after_load(self):
        mod.model = None
        mod.get_model()
        assert mod.model == "fallback"
        mod.model = "custom"
        assert mod.get_model() == "custom"

    def test_model_reset_to_none_reloads(self):
        mod.model = None
        mod.get_model()
        assert mod.model == "fallback"
        mod.model = None
        result = mod.get_model()
        assert result == "fallback"

    def test_concurrent_model_access(self):
        mod.model = None
        results = []
        async def access():
            results.append(mod.get_model())
        _run(asyncio.gather(access(), access(), access()))
        assert all(r == "fallback" for r in results)
        assert len(results) == 3


# ===========================================================================
# TestGenerateEmbeddingEdgeCases
# ===========================================================================

class TestGenerateEmbeddingEdgeCases:
    def test_only_special_characters(self):
        result = _run(mod.generate_embedding({"text": "!@#$%^&*()"}))
        assert len(result["embedding"]) == 128
        assert result["dim"] == 128

    def test_null_bytes_in_text(self):
        result = _run(mod.generate_embedding({"text": "hello\x00world"}))
        assert len(result["embedding"]) == 128

    def test_large_batch_100_items(self):
        batch = [f"item_{i}" for i in range(100)]
        result = _run(mod.generate_embedding({"batch": batch}))
        assert len(result["embeddings"]) == 100
        for emb in result["embeddings"]:
            assert len(emb) == 128

    def test_large_batch_200_items(self):
        batch = [f"text_{i}" for i in range(200)]
        result = _run(mod.generate_embedding({"batch": batch}))
        assert len(result["embeddings"]) == 200

    def test_batch_with_duplicate_items(self):
        result = _run(mod.generate_embedding({"batch": ["same", "same", "same"]}))
        assert result["embeddings"][0] == result["embeddings"][1]
        assert result["embeddings"][1] == result["embeddings"][2]

    def test_batch_with_empty_strings(self):
        result = _run(mod.generate_embedding({"batch": ["", "", ""]}))
        assert len(result["embeddings"]) == 3
        for emb in result["embeddings"]:
            assert all(v == 0.0 for v in emb)

    def test_batch_mixed_unicode(self):
        batch = ["hello", "世界", "مرحبا", "🎉"]
        result = _run(mod.generate_embedding({"batch": batch}))
        assert len(result["embeddings"]) == 4

    def test_numeric_text(self):
        result = _run(mod.generate_embedding({"text": "12345 67890"}))
        assert len(result["embedding"]) == 128

    def test_single_character_input(self):
        result = _run(mod.generate_embedding({"text": "a"}))
        assert len(result["embedding"]) == 128
        mag = sum(v * v for v in result["embedding"]) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_control_characters_mixed(self):
        result = _run(mod.generate_embedding({"text": "hello\r\n\tworld\r\ntest"}))
        assert len(result["embedding"]) == 128

    def test_embedding_dim_consistency_across_calls(self):
        r1 = _run(mod.generate_embedding({"text": "first"}))
        r2 = _run(mod.generate_embedding({"text": "second"}))
        r3 = _run(mod.generate_embedding({"text": "third"}))
        assert r1["dim"] == r2["dim"] == r3["dim"] == 128

    def test_embedding_values_are_bounded(self):
        result = _run(mod.generate_embedding({"text": "bounded test input"}))
        for v in result["embedding"]:
            assert -1.0 <= v <= 1.0

    def test_batch_embedding_values_are_bounded(self):
        result = _run(mod.generate_embedding({"batch": ["one", "two", "three"]}))
        for emb in result["embeddings"]:
            for v in emb:
                assert -1.0 <= v <= 1.0

    def test_whitespace_only_input(self):
        result = _run(mod.generate_embedding({"text": "   \t  \n  "}))
        assert len(result["embedding"]) == 128
        assert all(v == 0.0 for v in result["embedding"])

    def test_very_long_single_word(self):
        result = _run(mod.generate_embedding({"text": "a" * 10000}))
        assert len(result["embedding"]) == 128
        mag = sum(v * v for v in result["embedding"]) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_batch_single_and_text_ignored(self):
        result = _run(mod.generate_embedding({"text": "ignored", "batch": ["a", "b"]}))
        assert "embeddings" in result
        assert len(result["embeddings"]) == 2

    def test_text_with_leading_trailing_spaces(self):
        r1 = _run(mod.generate_embedding({"text": "  hello  "}))
        r2 = _run(mod.generate_embedding({"text": "hello"}))
        assert r1["embedding"] == r2["embedding"]

    def test_hyphenated_words(self):
        result = _run(mod.generate_embedding({"text": "well-known state-of-the-art"}))
        assert len(result["embedding"]) == 128


# ===========================================================================
# TestComputeSimilarityEdgeCases
# ===========================================================================

class TestComputeSimilarityEdgeCases:
    def test_high_dimensional_vectors_1000(self):
        import random
        random.seed(42)
        a = [random.gauss(0, 1) for _ in range(1000)]
        b = [random.gauss(0, 1) for _ in range(1000)]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert -1.0 <= result["similarity"] <= 1.0

    def test_nan_in_vector_a(self):
        a = [1.0, float("nan"), 3.0]
        b = [1.0, 2.0, 3.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert result["similarity"] == 0.0

    def test_nan_in_vector_b(self):
        a = [1.0, 2.0, 3.0]
        b = [1.0, float("nan"), 3.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert result["similarity"] == 0.0

    def test_infinity_in_vector(self):
        a = [1.0, float("inf"), 3.0]
        b = [1.0, 2.0, 3.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert isinstance(result["similarity"], float)

    def test_all_same_values_vectors(self):
        a = [5.0] * 10
        b = [5.0] * 10
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 1.0

    def test_alternating_signs(self):
        a = [1.0, -1.0, 1.0, -1.0]
        b = [-1.0, 1.0, -1.0, 1.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == -1.0

    def test_symmetry_property(self):
        a = [1.0, 2.0, 3.0, 4.0, 5.0]
        b = [5.0, 4.0, 3.0, 2.0, 1.0]
        sim_ab = _run(mod.compute_similarity({"a": a, "b": b}))
        sim_ba = _run(mod.compute_similarity({"a": b, "b": a}))
        assert pytest.approx(sim_ab["similarity"], abs=1e-12) == sim_ba["similarity"]

    def test_triangle_inequality_like(self):
        a = [1.0, 0.0, 0.0]
        b = [0.0, 1.0, 0.0]
        c = [0.0, 0.0, 1.0]
        sim_ab = _run(mod.compute_similarity({"a": a, "b": b}))["similarity"]
        sim_bc = _run(mod.compute_similarity({"a": b, "b": c}))["similarity"]
        sim_ac = _run(mod.compute_similarity({"a": a, "b": c}))["similarity"]
        assert sim_ab == sim_bc == sim_ac
        assert pytest.approx(sim_ab, abs=1e-9) == 0.0

    def test_integer_vectors(self):
        a = [1, 2, 3]
        b = [4, 5, 6]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert -1.0 <= result["similarity"] <= 1.0
        assert isinstance(result["similarity"], float)

    def test_mixed_int_float_vectors(self):
        a = [1, 2.0, 3]
        b = [4.0, 5, 6.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert -1.0 <= result["similarity"] <= 1.0

    def test_very_close_but_not_identical(self):
        a = [1.0, 2.0, 3.0]
        b = [1.0 + 1e-15, 2.0 + 1e-15, 3.0 + 1e-15]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 1.0

    def test_negative_infinity(self):
        a = [1.0, float("-inf"), 3.0]
        b = [1.0, 2.0, 3.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert isinstance(result["similarity"], float)

    def test_both_infinity_vectors(self):
        a = [float("inf"), float("inf")]
        b = [float("inf"), float("inf")]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert isinstance(result["similarity"], float)

    def test_one_element_different_rest_same(self):
        a = [1.0, 1.0, 1.0, 1.0, 1.0]
        b = [1.0, 1.0, 1.0, 1.0, 0.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert 0.0 < result["similarity"] < 1.0

    def test_sparse_like_vectors(self):
        a = [0.0] * 100
        a[0] = 1.0
        b = [0.0] * 100
        b[99] = 1.0
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        assert pytest.approx(result["similarity"], abs=1e-9) == 0.0

    def test_unit_vectors_dot_product_equals_similarity(self):
        a = [1.0 / (3 ** 0.5), 1.0 / (3 ** 0.5), 1.0 / (3 ** 0.5)]
        b = [1.0, 0.0, 0.0]
        result = _run(mod.compute_similarity({"a": a, "b": b}))
        expected = 1.0 / (3 ** 0.5)
        assert pytest.approx(result["similarity"], abs=1e-9) == expected


# ===========================================================================
# TestHashEmbedEdgeCases
# ===========================================================================

class TestHashEmbedEdgeCases:
    def test_dim_zero_returns_empty(self):
        result = mod._hash_embed("hello", dim=0)
        assert result == []

    def test_dim_1024(self):
        result = mod._hash_embed("test large dim", dim=1024)
        assert len(result) == 1024
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_repeated_characters(self):
        result = mod._hash_embed("aaaa bbbb cccc")
        assert len(result) == 128
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_numbers_only(self):
        result = mod._hash_embed("123 456 789")
        assert len(result) == 128
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_punctuation_only(self):
        result = mod._hash_embed("... !!! ???")
        assert len(result) == 128

    def test_word_order_independence(self):
        a = mod._hash_embed("alpha beta gamma")
        b = mod._hash_embed("gamma beta alpha")
        for va, vb in zip(a, b):
            assert pytest.approx(va, abs=1e-9) == vb

    def test_word_order_independence_two_words(self):
        a = mod._hash_embed("a b")
        b = mod._hash_embed("b a")
        for va, vb in zip(a, b):
            assert pytest.approx(va, abs=1e-9) == vb

    def test_no_nan_in_output(self):
        result = mod._hash_embed("check for nan values")
        assert not any(math.isnan(v) for v in result)

    def test_no_infinity_in_output(self):
        result = mod._hash_embed("check for inf values")
        assert not any(math.isinf(v) for v in result)

    def test_magnitude_consistency_different_texts(self):
        texts = ["hello", "world", "test", "embedding", "python"]
        for text in texts:
            result = mod._hash_embed(text)
            mag = sum(v * v for v in result) ** 0.5
            assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_single_character_words(self):
        result = mod._hash_embed("a b c d e f")
        assert len(result) == 128
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_dim_2(self):
        result = mod._hash_embed("tiny", dim=2)
        assert len(result) == 2
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_dim_3(self):
        result = mod._hash_embed("small", dim=3)
        assert len(result) == 3

    def test_mixed_whitespace_splits_correctly(self):
        a = mod._hash_embed("hello   world")
        b = mod._hash_embed("hello world")
        assert a == b

    def test_tab_splitting(self):
        a = mod._hash_embed("hello\tworld")
        b = mod._hash_embed("hello world")
        assert a == b

    def test_newline_splitting(self):
        a = mod._hash_embed("hello\nworld")
        b = mod._hash_embed("hello world")
        assert a == b

    def test_empty_text_all_zeros(self):
        result = mod._hash_embed("")
        assert all(v == 0.0 for v in result)

    def test_single_space_all_zeros(self):
        result = mod._hash_embed(" ")
        assert all(v == 0.0 for v in result)

    def test_dim_512(self):
        result = mod._hash_embed("medium dim", dim=512)
        assert len(result) == 512
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0


# ===========================================================================
# TestIntegrationEdgeCases
# ===========================================================================

class TestIntegrationEdgeCases:
    def test_full_pipeline_same_text_perfect_similarity(self):
        r1 = _run(mod.generate_embedding({"text": "deep learning"}))
        r2 = _run(mod.generate_embedding({"text": "deep learning"}))
        sim = _run(mod.compute_similarity({"a": r1["embedding"], "b": r2["embedding"]}))
        assert pytest.approx(sim["similarity"], abs=1e-9) == 1.0

    def test_batch_pairwise_similarity_matrix(self):
        texts = ["alpha", "beta", "gamma", "delta"]
        result = _run(mod.generate_embedding({"batch": texts}))
        embs = result["embeddings"]
        for i in range(len(embs)):
            sim_self = _run(mod.compute_similarity({"a": embs[i], "b": embs[i]}))
            assert pytest.approx(sim_self["similarity"], abs=1e-9) == 1.0
        for i in range(len(embs)):
            for j in range(i + 1, len(embs)):
                sim = _run(mod.compute_similarity({"a": embs[i], "b": embs[j]}))
                assert -1.0 <= sim["similarity"] <= 1.0

    def test_embedding_stability_multiple_runs(self):
        results = [_run(mod.generate_embedding({"text": "stability"})) for _ in range(5)]
        for r in results[1:]:
            assert r["embedding"] == results[0]["embedding"]

    def test_single_vs_batch_consistency(self):
        single = _run(mod.generate_embedding({"text": "consistent"}))
        batch = _run(mod.generate_embedding({"batch": ["consistent"]}))
        assert single["embedding"] == batch["embeddings"][0]

    def test_error_handling_wrong_type_text(self):
        with pytest.raises(AttributeError):
            _run(mod.generate_embedding({"text": 12345}))

    def test_concurrent_embedding_generation(self):
        async def gen_many():
            tasks = [mod.generate_embedding({"text": f"word_{i}"}) for i in range(10)]
            return await asyncio.gather(*tasks)
        results = _run(gen_many())
        assert len(results) == 10
        for r in results:
            assert len(r["embedding"]) == 128

    def test_generate_then_self_similarity(self):
        r = _run(mod.generate_embedding({"text": "self test"}))
        sim = _run(mod.compute_similarity({"a": r["embedding"], "b": r["embedding"]}))
        assert pytest.approx(sim["similarity"], abs=1e-9) == 1.0

    def test_different_texts_are_dissimilar(self):
        r1 = _run(mod.generate_embedding({"text": "apple orange banana"}))
        r2 = _run(mod.generate_embedding({"text": "neutron quantum galaxy"}))
        sim = _run(mod.compute_similarity({"a": r1["embedding"], "b": r2["embedding"]}))
        assert sim["similarity"] < 0.99

    def test_case_insensitive_embeddings(self):
        r1 = _run(mod.generate_embedding({"text": "Hello World"}))
        r2 = _run(mod.generate_embedding({"text": "hello world"}))
        assert r1["embedding"] == r2["embedding"]

    def test_batch_dim_matches_single_dim(self):
        single = _run(mod.generate_embedding({"text": "hello"}))
        batch = _run(mod.generate_embedding({"batch": ["hello", "world"]}))
        assert single["dim"] == batch["dim"]

    def test_empty_batch_falls_through_to_single(self):
        result = _run(mod.generate_embedding({"batch": []}))
        assert "embedding" in result
        assert "embeddings" not in result

    def test_pipeline_batch_to_pairwise(self):
        batch_result = _run(mod.generate_embedding({"batch": ["cat", "cat"]}))
        sim = _run(mod.compute_similarity({
            "a": batch_result["embeddings"][0],
            "b": batch_result["embeddings"][1],
        }))
        assert pytest.approx(sim["similarity"], abs=1e-9) == 1.0

    def test_many_unique_texts_all_have_valid_embeddings(self):
        for i in range(50):
            r = _run(mod.generate_embedding({"text": f"unique_text_{i}"}))
            assert len(r["embedding"]) == 128
            assert r["dim"] == 128

    def test_similarity_result_has_similarity_key(self):
        r = _run(mod.compute_similarity({"a": [1.0], "b": [1.0]}))
        assert "similarity" in r
        assert isinstance(r["similarity"], float)

    def test_generate_result_has_correct_keys_single(self):
        r = _run(mod.generate_embedding({"text": "keys test"}))
        assert "embedding" in r
        assert "dim" in r
        assert isinstance(r["embedding"], list)
        assert isinstance(r["dim"], int)

    def test_generate_result_has_correct_keys_batch(self):
        r = _run(mod.generate_embedding({"batch": ["a", "b"]}))
        assert "embeddings" in r
        assert "dim" in r
        assert isinstance(r["embeddings"], list)
        assert isinstance(r["dim"], int)


# ===========================================================================
# TestNormalization
# ===========================================================================

class TestNormalization:
    def test_single_text_embedding_is_unit_vector(self):
        result = _run(mod.generate_embedding({"text": "unit vector test"}))
        mag = sum(v * v for v in result["embedding"]) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_batch_embeddings_are_unit_vectors(self):
        result = _run(mod.generate_embedding({"batch": ["one", "two", "three"]}))
        for emb in result["embeddings"]:
            mag = sum(v * v for v in emb) ** 0.5
            assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_hash_embed_dim_64_unit_vector(self):
        result = mod._hash_embed("dim64", dim=64)
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_hash_embed_dim_256_unit_vector(self):
        result = mod._hash_embed("dim256", dim=256)
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_hash_embed_dim_512_unit_vector(self):
        result = mod._hash_embed("dim512", dim=512)
        mag = sum(v * v for v in result) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_dot_product_unit_vector_with_itself(self):
        emb = mod._hash_embed("self dot product")
        dot = sum(v * v for v in emb)
        assert pytest.approx(dot, abs=1e-9) == 1.0

    def test_empty_text_magnitude_is_zero(self):
        emb = mod._hash_embed("")
        mag = sum(v * v for v in emb) ** 0.5
        assert mag == 0.0

    def test_whitespace_text_magnitude_is_zero(self):
        emb = mod._hash_embed("  \t\n  ")
        mag = sum(v * v for v in emb) ** 0.5
        assert mag == 0.0

    def test_generated_embedding_dot_product_self_is_one(self):
        r = _run(mod.generate_embedding({"text": "dot product check"}))
        dot = sum(v * v for v in r["embedding"])
        assert pytest.approx(dot, abs=1e-9) == 1.0

    def test_all_embeddings_normalized_in_batch(self):
        batch = [f"word{i}" for i in range(20)]
        result = _run(mod.generate_embedding({"batch": batch}))
        for emb in result["embeddings"]:
            mag = sum(v * v for v in emb) ** 0.5
            assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_long_text_still_normalized(self):
        text = " ".join(f"word{i}" for i in range(1000))
        result = _run(mod.generate_embedding({"text": text}))
        mag = sum(v * v for v in result["embedding"]) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0

    def test_single_word_normalized(self):
        result = _run(mod.generate_embedding({"text": "singleton"}))
        mag = sum(v * v for v in result["embedding"]) ** 0.5
        assert pytest.approx(mag, abs=1e-9) == 1.0
