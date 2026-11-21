import re
import unittest
from pathlib import Path


def _load_filters():
    src = Path(__file__).resolve().parents[2] / "main.py"
    text = src.read_text(encoding="utf-8")
    start = text.index("_INVALID_EXACT_TITLES = {")
    end = text.index("def search_youporn_with_ytdlp")
    ns = {"re": re}
    exec(text[start:end], ns)
    return ns


class AdFilterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = _load_filters()

    def test_filters_rta_and_ad_cards(self):
        is_filtered = self.ns["is_filtered_video_item"]
        self.assertTrue(is_filtered({"title": "RTA", "url": "https://www.redtube.com/123", "provider": "redtube"}, "redtube"))
        self.assertTrue(is_filtered({"title": "RTA", "url": "https://www.rtalabel.org/", "provider": "redtube"}, "redtube"))
        self.assertTrue(is_filtered({"title": "Sponsored", "url": "https://www.youporn.com/watch/123456/test/", "provider": "youporn"}, "youporn"))
        self.assertTrue(is_filtered({"title": "Valid Title", "url": "https://www.redtube.com/information/rta", "provider": "redtube"}, "redtube"))
        self.assertTrue(is_filtered({"title": "Valid Title", "url": "https://www.youporn.com/information/2257", "provider": "youporn"}, "youporn"))
        self.assertFalse(is_filtered({"title": "Real Scene Title", "url": "https://www.redtube.com/48291023", "provider": "redtube"}, "redtube"))
        self.assertFalse(is_filtered({"title": "Real YouPorn Scene", "url": "https://www.youporn.com/watch/18293041/sample-video/", "provider": "youporn"}, "youporn"))


if __name__ == "__main__":
    unittest.main()
