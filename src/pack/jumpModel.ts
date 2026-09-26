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

export type LabeledJump = { x: JumpFeatures; good: boolean }

export function predictGood(model: JumpModel, x: JumpFeatures): number {
  let z = model.bias
  model.features.forEach((name, i) => { z += model.weights[i]! * (x[name] - model.mean[i]!) / model.std[i]! })
  return 1 / (1 + Math.exp(-z))
}

export function fitJumpModel(rows: LabeledJump[], features: JumpFeatureName[], version: string,
  { l2 = 1, iterations = 3000, learningRate = 0.2 } = {}): JumpModel {
  const n = rows.length
  const mean = features.map(name => rows.reduce((sum, row) => sum + row.x[name], 0) / Math.max(1, n))
  const std = features.map((name, i) => Math.sqrt(rows.reduce((sum, row) => sum + (row.x[name] - mean[i]!) ** 2, 0)
    / Math.max(1, n)) || 1)
  const xs = rows.map(row => features.map((name, i) => (row.x[name] - mean[i]!) / std[i]!))
  const ys = rows.map(row => row.good ? 1 : 0)
  const weights = features.map(() => 0)
  let bias = 0
  for (let step = 0; step < iterations; step++) {
    const grad = features.map(() => 0)
    let gradBias = 0
    for (let r = 0; r < n; r++) {
      const z = bias + weights.reduce((sum, w, i) => sum + w * xs[r]![i]!, 0)
      const error = 1 / (1 + Math.exp(-z)) - ys[r]!
      for (let i = 0; i < weights.length; i++) grad[i]! += error * xs[r]![i]!
      gradBias += error
    }
    for (let i = 0; i < weights.length; i++) weights[i]! -= learningRate * (grad[i]! / n + l2 * weights[i]! / n)
    bias -= learningRate * gradBias / n
  }
  return { version, features, mean, std, weights, bias }
}
