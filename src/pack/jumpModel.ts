import type { JumpFeatureName, JumpFeatures } from './jumpFeatures'

/** Standardized L2-regularized logistic regression: P(listener rates the jump Good). */
export type JumpModel = {
  version: string
  features: JumpFeatureName[]
  mean: number[]
  std: number[]
  weights: number[]
  bias: number
}

export function predictGood(model: JumpModel, x: JumpFeatures): number {
  let z = model.bias
  model.features.forEach((name, i) => { z += model.weights[i]! * (x[name] - model.mean[i]!) / model.std[i]! })
  return 1 / (1 + Math.exp(-z))
}
