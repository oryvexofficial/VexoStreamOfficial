import ast
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]


def function_node(path: pathlib.Path, name: str):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"function not found: {name}")


class StreamFreshnessTests(unittest.TestCase):
    def test_extraction_does_not_read_or_write_the_stream_cache(self):
        node = function_node(ROOT / "main.py", "extract_with_ytdlp")
        names = {
            item.id
            for item in ast.walk(node)
            if isinstance(item, ast.Name)
        }
        self.assertNotIn(
            "extraction_cache",
            names,
            "signed provider URLs must be re-resolved for every playback retry",
        )

    def test_both_extraction_endpoints_disable_http_caching(self):
        for filename in ("main.py", "server.py"):
            node = function_node(ROOT / filename, "extract_endpoint")
            constants = {
                item.value
                for item in ast.walk(node)
                if isinstance(item, ast.Constant) and isinstance(item.value, str)
            }
            self.assertIn("Cache-Control", constants, filename)
            self.assertIn("no-store, max-age=0", constants, filename)


if __name__ == "__main__":
    unittest.main()
