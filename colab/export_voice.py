"""Export a Piper checkpoint to ONNX (legacy TorchScript exporter, opset 15) for phone playback."""
import sys, inspect, torch
from piper.train.vits.lightning import VitsModel

ckpt, out = sys.argv[1], sys.argv[2]
torch.manual_seed(1234)
model = VitsModel.load_from_checkpoint(ckpt, map_location="cpu")
g = model.model_g
g.eval()
with torch.no_grad():
    g.dec.remove_weight_norm()

def infer_forward(text, text_lengths, scales, sid=None):
    return g.infer(text, text_lengths, noise_scale=scales[0], length_scale=scales[1],
                   noise_scale_w=scales[2], sid=sid)[0].unsqueeze(1)
g.forward = infer_forward

seq = torch.randint(0, g.n_vocab, (1, 50), dtype=torch.long)
lens = torch.LongTensor([50])
scales = torch.FloatTensor([0.667, 1.0, 0.8])
sid = torch.LongTensor([0]) if g.n_speakers > 1 else None
kw = {}
if "dynamo" in inspect.signature(torch.onnx.export).parameters:
    kw["dynamo"] = False
torch.onnx.export(g, (seq, lens, scales, sid), out, opset_version=15,
                  input_names=["input", "input_lengths", "scales", "sid"], output_names=["output"],
                  dynamic_axes={"input": {0: "batch_size", 1: "phonemes"}, "input_lengths": {0: "batch_size"},
                                "output": {0: "batch_size", 2: "time"}}, **kw)
print("Exported", out)
