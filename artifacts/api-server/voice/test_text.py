import unittest
from text import prepare_text


class VoiceTextTests(unittest.TestCase):
    def setUp(self):
        self.vocab = set(" abcdefghijklmnopqrstuvwxyzáéíóöőúüűàč0123456789.,!?;:'\"-%&")

    def test_does_not_add_a_lead_in_and_preserves_hungarian_words(self):
        self.assertEqual(prepare_text("Szia, Zara vagyok.", self.vocab),
                         "szia, zara vagyok.")
        self.assertIn("csütörtök", prepare_text("Csütörtök", self.vocab))

    def test_preserves_existing_text_and_punctuation_without_adding_words(self):
        self.assertEqual(prepare_text("Rendben. Szia!", self.vocab), "rendben. szia!")

    def test_removes_decorations_without_dropping_hungarian_letters(self):
        self.assertEqual(prepare_text("**Örülök** 😊", self.vocab), "örülök")

    def test_rejects_unsupported_characters_and_empty_speech(self):
        for text in ["你好", "😊", ""]:
            with self.assertRaises(ValueError):
                prepare_text(text, self.vocab)


if __name__ == "__main__":
    unittest.main()
