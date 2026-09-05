#!/usr/bin/env python3
"""Quantiza o ArcFace pra int8 (~12MB -> ~3.5MB no download do cliente).

Quantização ESTÁTICA: o modelo é quase todo Conv, e no modo dinâmico o
onnxruntime não quantiza Conv — o arquivo mal encolheria. A estática precisa de
um conjunto de calibração, que sai de `scripts/dump-calibration.ts` já com o
mesmo pré-processamento do índice e do navegador.

Depois de trocar o modelo, **rebuild o índice**: embedding quantizado não é
numericamente igual ao fp32, e comparar vetores de modelos diferentes devolve
lixo com cara de resultado.

Uso:
  python3 scripts/quantize-arcface.py <dir-calibracao> [saida.onnx]
"""
import glob
import os
import sys

import numpy as np
from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantFormat,
    QuantType,
    quantize_static,
)
from onnxruntime.quantization.shape_inference import quant_pre_process

HERE = os.path.dirname(os.path.abspath(__file__))
# O fp32 fica fora de public/: só o int8 é publicado pro navegador.
SRC = os.path.join(HERE, "..", ".models-build", "w600k_mbf.onnx")
INPUT_SHAPE = (1, 3, 112, 112)


class TensorReader(CalibrationDataReader):
    def __init__(self, directory, input_name):
        self.input_name = input_name
        self.files = sorted(glob.glob(os.path.join(directory, "*.f32")))
        if not self.files:
            raise SystemExit(f"sem tensores de calibração em {directory}")
        self.i = 0

    def get_next(self):
        if self.i >= len(self.files):
            return None
        data = np.fromfile(self.files[self.i], dtype=np.float32).reshape(INPUT_SHAPE)
        self.i += 1
        return {self.input_name: data}

    def rewind(self):
        self.i = 0


def main():
    if len(sys.argv) < 2:
        raise SystemExit("uso: quantize-arcface.py <dir-calibracao> [saida.onnx]")
    calib_dir = sys.argv[1]
    out = (
        sys.argv[2]
        if len(sys.argv) > 2
        else os.path.join(HERE, "..", "public", "models", "arcface", "w600k_mbf.int8.onnx")
    )

    import onnx
    import onnxruntime as ort

    # O modelo publicado é opset 11; QDQ por canal exige 13+.
    upgraded = out + ".op13.onnx"
    model = onnx.load(SRC)
    if max(i.version for i in model.opset_import if i.domain in ("", "ai.onnx")) < 13:
        model = onnx.version_converter.convert_version(model, 13)
    onnx.save(model, upgraded)

    prepared = out + ".prep.onnx"
    quant_pre_process(upgraded, prepared, skip_symbolic_shape=True)

    input_name = ort.InferenceSession(SRC).get_inputs()[0].name
    quantize_static(
        prepared,
        out,
        TensorReader(calib_dir, input_name),
        quant_format=QuantFormat.QDQ,
        # Peso por canal preserva bem mais precisão em Conv que por tensor.
        per_channel=True,
        weight_type=QuantType.QInt8,
        activation_type=QuantType.QUInt8,
    )
    os.remove(prepared)
    os.remove(upgraded)

    src_mb = os.path.getsize(SRC) / 1048576
    out_mb = os.path.getsize(out) / 1048576
    print(f"{src_mb:.1f} MB -> {out_mb:.1f} MB  ({out})")


if __name__ == "__main__":
    main()
