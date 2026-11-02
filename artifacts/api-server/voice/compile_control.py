"""Opt-in, process-local torch.compile control for the Zara F5 prototype."""


def read_compile_options(environ):
    mode = environ.get("ZARA_F5_COMPILE_MODE", "eager").strip().lower()
    if mode not in {"eager", "reduce-overhead"}:
        raise ValueError("ZARA_F5_COMPILE_MODE must be eager or reduce-overhead.")

    warmup = environ.get("ZARA_F5_COMPILE_WARMUP") == "1"
    if warmup and mode != "reduce-overhead":
        raise ValueError("ZARA_F5_COMPILE_WARMUP requires reduce-overhead mode.")
    return {"mode": mode, "warmup": warmup}


class CompileController:
    """Wrap only the F5 DiT transformer and restore Eager after any compile error."""

    def __init__(self, model, mode, compile_fn, reset_fn=None):
        self.model = model
        self.mode = mode
        self.compile_fn = compile_fn
        self.reset_fn = reset_fn or (lambda: None)
        self.eager_transformer = model.ema_model.transformer
        self.active = False
        self.fallback_used = False
        self.fallback_error_type = None

    def configure(self):
        if self.mode == "eager":
            return
        try:
            compiled = self.compile_fn(self.eager_transformer, mode=self.mode)
            self.model.ema_model.transformer = compiled
            self.active = True
        except Exception as error:
            self._restore_eager(error)

    def run(self, operation):
        if not self.active:
            return operation()
        try:
            return operation()
        except Exception as error:
            self._restore_eager(error)
            return operation()

    def _restore_eager(self, error):
        self.model.ema_model.transformer = self.eager_transformer
        self.active = False
        self.fallback_used = True
        # Keep only the type: retaining the exception also retains its traceback
        # and potentially large compiled-inference tensors.
        self.fallback_error_type = type(error).__name__
        clear_cache = getattr(self.eager_transformer, "clear_cache", None)
        if callable(clear_cache):
            clear_cache()
        try:
            self.reset_fn()
        except Exception:
            # Reset is best-effort; Eager inference remains the safe fallback.
            pass

    def diagnostics(self, torch_module):
        unique_graphs = 0
        calls_captured = 0
        if self.mode != "eager":
            try:
                counters = torch_module._dynamo.utils.counters["stats"]
                unique_graphs = int(counters["unique_graphs"])
                calls_captured = int(counters["calls_captured"])
            except Exception:
                pass
        return {
            "mode": self.mode,
            "active": self.active,
            "fallbackUsed": self.fallback_used,
            "fallbackErrorType": self.fallback_error_type,
            "dynamoUniqueGraphs": unique_graphs,
            "dynamoCallsCaptured": calls_captured,
        }
