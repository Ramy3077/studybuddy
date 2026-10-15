---
source: StudyBuddy demo corpus (original content)
topic: loss functions
---
# Loss Functions

## Why a loss function

A loss function turns "how wrong is the model" into a single number that training can minimise. Learning then becomes an optimisation problem: search for the parameters that give the lowest average loss on the training data. The choice of loss decides which mistakes the model cares about most.

## Mean squared error

Mean squared error averages the squared residuals over all examples. Squaring makes every error positive and punishes large errors much more than small ones, so a single error of 10 costs as much as one hundred errors of 1. Mean squared error is smooth and differentiable everywhere, which makes it convenient for gradient-based training.

## Mean absolute error

Mean absolute error averages the absolute values of the residuals instead. Because it grows linearly rather than quadratically, it is far less sensitive to outliers than mean squared error. The price is that its gradient does not shrink near the minimum, which can make optimisation less smooth.

## Least squares and the normal equation

Fitting linear regression by minimising mean squared error is called ordinary least squares. For this model there is a closed-form answer, known as the normal equation, which solves for the best weights in one step using matrix algebra. The normal equation needs to invert a matrix whose size grows with the number of features, so it becomes slow when there are many thousands of features. In that case an iterative method such as gradient descent is the usual choice.

## Training loss versus test loss

The loss on the training data tells you how well the model fits what it has already seen. It says little about new data. To estimate real performance, keep a separate test set that is never used for fitting and report the loss on that set. A model with a very low training loss and a much higher test loss is memorising rather than learning.
