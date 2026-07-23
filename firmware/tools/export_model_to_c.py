from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import joblib


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export SpineGuard LightGBM model to compact C arrays.")
    parser.add_argument("--model", required=True, help="posture_lightgbm.joblib path")
    parser.add_argument("--output-dir", required=True, help="directory for posture_model.c/.h")
    return parser.parse_args()


def c_float(value: float) -> str:
    # Nine significant digits are enough to round-trip IEEE-754 float values.
    text = format(float(value), ".9g")
    if "e" not in text and "." not in text:
        text += ".0"
    return text + "f"


def main() -> int:
    args = parse_args()
    bundle = joblib.load(args.model)
    model = bundle["model"]
    feature_names = list(bundle["feature_names"])
    postures = list(bundle["postures"])
    dump = model.booster_.dump_model()

    if int(dump["num_class"]) != len(postures):
        raise ValueError("num_class does not match posture labels")
    if int(dump["num_tree_per_iteration"]) != len(postures):
        raise ValueError("unexpected LightGBM multiclass tree layout")
    if len(feature_names) > 127:
        raise ValueError("feature index no longer fits int8_t")

    nodes: list[dict[str, Any] | None] = []
    roots: list[int] = []

    def append_node(node: dict[str, Any]) -> int:
        index = len(nodes)
        nodes.append(None)
        if "leaf_value" in node:
            nodes[index] = {
                "feature": -1,
                "left": -1,
                "right": -1,
                "value": float(node["leaf_value"]),
            }
            return index

        if node.get("decision_type") != "<=":
            raise ValueError(f"unsupported decision type: {node.get('decision_type')}")
        if node.get("missing_type") not in (None, "None"):
            raise ValueError(f"unsupported missing type: {node.get('missing_type')}")

        left = append_node(node["left_child"])
        right = append_node(node["right_child"])
        nodes[index] = {
            "feature": int(node["split_feature"]),
            "left": left,
            "right": right,
            "value": float(node["threshold"]),
        }
        return index

    for tree in dump["tree_info"]:
        roots.append(append_node(tree["tree_structure"]))

    if len(nodes) >= 32767:
        raise ValueError("node index no longer fits int16_t")
    if len(roots) >= 32767:
        raise ValueError("tree index no longer fits int16_t")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    header_path = output_dir / "posture_model.h"
    source_path = output_dir / "posture_model.c"

    header = f'''#ifndef SPINEGUARD_POSTURE_MODEL_H\n#define SPINEGUARD_POSTURE_MODEL_H\n\n#include <stddef.h>\n\n#ifdef __cplusplus\nextern "C" {{\n#endif\n\n#define POSTURE_MODEL_FEATURE_COUNT {len(feature_names)}\n#define POSTURE_MODEL_CLASS_COUNT {len(postures)}\n#define POSTURE_MODEL_VERSION "{bundle['model_version']}"\n\ntypedef enum {{\n    POSTURE_NORMAL = 0,\n    POSTURE_LEFT_LEAN = 1,\n    POSTURE_RIGHT_LEAN = 2,\n    POSTURE_FRONT_LEAN = 3,\n    POSTURE_BACK_LEAN = 4,\n    POSTURE_UNKNOWN = -1,\n    POSTURE_EMPTY = -2,\n}} posture_class_t;\n\nposture_class_t posture_model_predict(\n    const float features[POSTURE_MODEL_FEATURE_COUNT],\n    float probabilities[POSTURE_MODEL_CLASS_COUNT]\n);\n\nconst char *posture_model_label(posture_class_t posture);\n\n#ifdef __cplusplus\n}}\n#endif\n\n#endif\n'''
    header_path.write_text(header, encoding="utf-8")

    feature_comments = "\n".join(
        f" * {index:2d}: {name}" for index, name in enumerate(feature_names)
    )
    node_lines = []
    for node in nodes:
        assert node is not None
        node_lines.append(
            "    { %s, %d, %d, %d }," % (
                c_float(node["value"]),
                int(node["left"]),
                int(node["right"]),
                int(node["feature"]),
            )
        )
    root_lines = []
    for start in range(0, len(roots), 16):
        root_lines.append("    " + ", ".join(str(value) for value in roots[start:start + 16]) + ",")

    labels = ",\n".join(f'    "{label}"' for label in postures)
    source = f'''#include "posture_model.h"\n\n#include <math.h>\n#include <stdint.h>\n\n/*\n * Generated from {Path(args.model).name}. Do not edit by hand.\n * Feature order:\n{feature_comments}\n */\n\ntypedef struct {{\n    float value;      /* threshold for split node; prediction value for leaf */\n    int16_t left;\n    int16_t right;\n    int8_t feature;   /* -1 means leaf */\n}} posture_model_node_t;\n\nstatic const posture_model_node_t MODEL_NODES[{len(nodes)}] = {{\n{chr(10).join(node_lines)}\n}};\n\nstatic const int16_t MODEL_ROOTS[{len(roots)}] = {{\n{chr(10).join(root_lines)}\n}};\n\nstatic const char *const MODEL_LABELS[POSTURE_MODEL_CLASS_COUNT] = {{\n{labels}\n}};\n\nstatic float evaluate_tree(int16_t node_index, const float *features)\n{{\n    while (MODEL_NODES[node_index].feature >= 0) {{\n        const posture_model_node_t *node = &MODEL_NODES[node_index];\n        const float value = features[(int)node->feature];\n        node_index = value <= node->value ? node->left : node->right;\n    }}\n    return MODEL_NODES[node_index].value;\n}}\n\nposture_class_t posture_model_predict(\n    const float features[POSTURE_MODEL_FEATURE_COUNT],\n    float probabilities[POSTURE_MODEL_CLASS_COUNT]\n)\n{{\n    float scores[POSTURE_MODEL_CLASS_COUNT] = {{0}};\n\n    for (int tree = 0; tree < {len(roots)}; ++tree) {{\n        const int class_id = tree % POSTURE_MODEL_CLASS_COUNT;\n        scores[class_id] += evaluate_tree(MODEL_ROOTS[tree], features);\n    }}\n\n    float maximum = scores[0];\n    for (int i = 1; i < POSTURE_MODEL_CLASS_COUNT; ++i) {{\n        if (scores[i] > maximum) {{\n            maximum = scores[i];\n        }}\n    }}\n\n    float sum = 0.0f;\n    for (int i = 0; i < POSTURE_MODEL_CLASS_COUNT; ++i) {{\n        probabilities[i] = expf(scores[i] - maximum);\n        sum += probabilities[i];\n    }}\n    if (sum <= 0.0f || !isfinite(sum)) {{\n        for (int i = 0; i < POSTURE_MODEL_CLASS_COUNT; ++i) {{\n            probabilities[i] = 0.0f;\n        }}\n        return POSTURE_UNKNOWN;\n    }}\n\n    int best = 0;\n    for (int i = 0; i < POSTURE_MODEL_CLASS_COUNT; ++i) {{\n        probabilities[i] /= sum;\n        if (probabilities[i] > probabilities[best]) {{\n            best = i;\n        }}\n    }}\n    return (posture_class_t)best;\n}}\n\nconst char *posture_model_label(posture_class_t posture)\n{{\n    if (posture == POSTURE_EMPTY) {{\n        return "empty";\n    }}\n    if (posture < 0 || posture >= POSTURE_MODEL_CLASS_COUNT) {{\n        return "unknown";\n    }}\n    return MODEL_LABELS[(int)posture];\n}}\n'''
    source_path.write_text(source, encoding="utf-8")

    print(f"wrote {header_path}")
    print(f"wrote {source_path}")
    print(f"trees={len(roots)} nodes={len(nodes)} features={len(feature_names)} classes={len(postures)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
