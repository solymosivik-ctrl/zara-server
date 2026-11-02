import unittest
from types import SimpleNamespace

from compile_control import CompileController, read_compile_options


class CompileControlTests(unittest.TestCase):
    def make_model(self, transformer):
        return SimpleNamespace(ema_model=SimpleNamespace(transformer=transformer))

    def test_eager_is_the_default_and_does_not_compile(self):
        options = read_compile_options({})
        transformer = object()
        calls = []
        model = self.make_model(transformer)
        controller = CompileController(
            model, options["mode"],
            lambda *args, **kwargs: calls.append((args, kwargs)),
        )
        controller.configure()
        self.assertEqual(options, {"mode": "eager", "warmup": False})
        self.assertIs(model.ema_model.transformer, transformer)
        self.assertEqual(calls, [])

    def test_only_reduce_overhead_can_be_enabled(self):
        self.assertEqual(
            read_compile_options({"ZARA_F5_COMPILE_MODE": "reduce-overhead"}),
            {"mode": "reduce-overhead", "warmup": False},
        )
        with self.assertRaisesRegex(ValueError, "must be eager or reduce-overhead"):
            read_compile_options({"ZARA_F5_COMPILE_MODE": "default"})
        with self.assertRaisesRegex(ValueError, "requires reduce-overhead"):
            read_compile_options({"ZARA_F5_COMPILE_WARMUP": "1"})

    def test_compile_wraps_only_the_existing_transformer(self):
        original = object()
        compiled = object()
        model = self.make_model(original)
        controller = CompileController(
            model, "reduce-overhead",
            lambda module, **kwargs: compiled,
        )
        controller.configure()
        self.assertIs(model.ema_model.transformer, compiled)
        self.assertTrue(controller.active)
        self.assertFalse(controller.fallback_used)

    def test_compile_setup_failure_keeps_eager_without_aborting(self):
        original = object()
        model = self.make_model(original)

        def fail_compile(*args, **kwargs):
            raise RuntimeError("backend unavailable")

        controller = CompileController(model, "reduce-overhead", fail_compile)
        controller.configure()
        self.assertIs(model.ema_model.transformer, original)
        self.assertFalse(controller.active)
        self.assertTrue(controller.fallback_used)
        self.assertEqual(controller.fallback_error_type, "RuntimeError")

    def test_lazy_compile_failure_retries_current_operation_in_eager(self):
        calls = []
        original = SimpleNamespace(clear_cache=lambda: calls.append("clear-cache"))
        model = self.make_model(original)
        compiled = object()
        controller = CompileController(
            model, "reduce-overhead",
            lambda module, **kwargs: compiled,
            reset_fn=lambda: calls.append("reset"),
        )
        controller.configure()

        def operation():
            calls.append("compiled" if model.ema_model.transformer is compiled else "eager")
            if model.ema_model.transformer is compiled:
                raise RuntimeError("compile failed")
            return "audio"

        self.assertEqual(controller.run(operation), "audio")
        self.assertEqual(calls, [
            "compiled", "clear-cache", "reset", "eager",
        ])
        self.assertIs(model.ema_model.transformer, original)
        self.assertFalse(controller.active)
        self.assertTrue(controller.fallback_used)
        self.assertEqual(controller.fallback_error_type, "RuntimeError")


if __name__ == "__main__":
    unittest.main()
