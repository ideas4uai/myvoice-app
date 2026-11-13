"""Fine-tune a Piper voice on your recordings.

Same as `python -m piper.train fit ...` but with checkpointing tuned for Colab:
no 846 MB checkpoint per epoch; instead a resume copy every BACKUP_EVERY epochs
(to Google Drive) and a final checkpoint when training ends.
"""
import os
from pathlib import Path

from lightning.pytorch.callbacks import Callback
from piper.train.__main__ import VitsLightningCLI
from piper.train.vits.dataset import VitsDataModule
from piper.train.vits.lightning import VitsModel

BACKUP = os.environ.get("BACKUP_CKPT")          # e.g. /content/drive/MyDrive/MyVoice/resume.ckpt
FINAL = os.environ.get("FINAL_CKPT", "final.ckpt")
EVERY = int(os.environ.get("BACKUP_EVERY", "100"))
INIT = os.environ.get("INIT_WEIGHTS")          # base voice checkpoint to start from (fresh run only)


def _atomic_save(trainer, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    trainer.save_checkpoint(str(tmp))
    os.replace(tmp, path)


class WarmStart(Callback):
    """Copy the base voice's weights into the model before training (fine-tuning)."""

    def setup(self, trainer, pl_module, stage):
        if not INIT or getattr(self, "_done", False):
            return
        import torch

        state = torch.load(INIT, map_location="cpu", weights_only=False)["state_dict"]
        own = pl_module.state_dict()
        ok = {k: v for k, v in state.items() if k in own and own[k].shape == v.shape}
        pl_module.load_state_dict(ok, strict=False)
        print(f"Warm start from {Path(INIT).name}: loaded {len(ok)}/{len(own)} tensors", flush=True)
        self._done = True


class Progress(Callback):
    def on_train_epoch_end(self, trainer, pl_module):
        epoch = trainer.current_epoch + 1
        left = (trainer.max_epochs or 0) - epoch
        m = trainer.callback_metrics
        if epoch % 10 == 0:
            print(f"epoch {epoch}  ({left} to go)  gen={float(m.get('loss_g', 0)):.2f}  disc={float(m.get('loss_d', 0)):.2f}", flush=True)
        if BACKUP and epoch % EVERY == 0:
            _atomic_save(trainer, BACKUP)
            print(f"  saved resume point -> {BACKUP}", flush=True)

    def on_train_end(self, trainer, pl_module):
        _atomic_save(trainer, FINAL)
        print(f"Training finished. Final checkpoint: {FINAL}", flush=True)
        if BACKUP:
            _atomic_save(trainer, BACKUP)


if __name__ == "__main__":
    import logging
    import torch

    logging.basicConfig(level=logging.WARNING)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    VitsLightningCLI(
        VitsModel,
        VitsDataModule,
        save_config_callback=None,
        trainer_defaults={
            "max_epochs": -1,
            "callbacks": [WarmStart(), Progress()],
            "enable_checkpointing": False,
            "logger": False,
            "enable_progress_bar": False,
        },
    )
