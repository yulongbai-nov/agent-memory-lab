"use strict";
// Evaluation only; this module is loaded after requests have been constructed.
module.exports = {
  "temporal-slot": [
    {
      values: ["tuesday", "tue"],
      required: [["clarify"]],
      relevant: ["original", "clarify"],
      correction: true,
    },
    {
      values: ["wednesday", "wed"],
      required: [["move"], ["repeat-move"]],
      relevant: ["move", "repeat-move"],
    },
  ],
  dependency: [
    {
      values: ["prepare the checklist", "prepare checklist"],
      required: [["task", "relation"]],
      relevant: ["task", "relation"],
      relation: true,
    },
    {
      values: ["wednesday", "wed"],
      required: [["move"], ["repeat-move"]],
      relevant: ["move", "repeat-move"],
    },
  ],
  "held-temporal": [
    {
      values: ["east drawer", "the east drawer"],
      required: [["old", "clarify"]],
      relevant: ["old", "clarify"],
      correction: true,
    },
    {
      values: ["north cabinet", "the north cabinet"],
      required: [["change"]],
      relevant: ["change"],
    },
  ],
  "held-dependency": [
    {
      values: ["mount the print label", "mount print label"],
      required: [["task", "relation"]],
      relevant: ["task", "relation"],
      relation: true,
    },
    {
      values: ["violet cabinet", "the violet cabinet"],
      required: [["changed"]],
      relevant: ["changed"],
    },
  ],
};
