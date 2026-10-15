---
source: StudyBuddy demo corpus (original content)
topic: gradient descent
---
# Gradient Descent

## The idea

Gradient descent is an iterative way to find parameters that minimise a loss function. Picture the loss as a landscape of hills and valleys over the space of parameters. Starting from some initial point, the algorithm repeatedly takes a small step downhill until it reaches a low point.

## The update rule

The gradient of the loss points in the direction of steepest increase. Gradient descent therefore moves the parameters in the opposite direction of the gradient. Each update subtracts the gradient multiplied by a small positive number called the learning rate. The update is applied to every parameter at the same time, and the process repeats until the loss stops improving.

## Batch, stochastic and mini-batch

Batch gradient descent computes the gradient using every training example before taking one step. It gives an accurate direction but each step is expensive on large datasets. Stochastic gradient descent updates the parameters after every single example, which is cheap per step but makes the path noisy. Mini-batch gradient descent is the common compromise: it estimates the gradient from a small random subset of examples, often between 32 and 256 at a time.

## Convergence

For a convex loss such as mean squared error in linear regression, there is only one minimum, so gradient descent with a suitable learning rate will reach the global minimum. For non-convex losses, such as those of deep neural networks, the algorithm may settle in a local minimum or slow down on a flat region. In practice training stops after a fixed number of passes over the data, called epochs, or when the validation loss stops falling.

## Why noise can help

The noise in stochastic and mini-batch updates is not only a cost. Random variation in the gradient can push the parameters out of shallow local minima and saddle points that would trap a perfectly accurate gradient. This is one reason mini-batch training works so well on large non-convex models.
