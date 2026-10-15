---
source: StudyBuddy demo corpus (original content)
topic: overfitting, underfitting and the bias-variance trade-off
---
# Overfitting and Underfitting

## Two ways to fail

A model underfits when it is too simple to capture the real pattern in the data. It performs badly on the training set and on new data alike. A model overfits when it is so flexible that it also learns the random noise in the training set. It then scores very well on the training data but poorly on data it has not seen.

## A picture to keep in mind

Imagine fitting polynomials of increasing degree to twenty noisy points that follow a gentle curve. A straight line misses the curve and underfits. A low-degree polynomial follows the curve and generalises well. A very high-degree polynomial passes through every single point, wiggling wildly between them, and overfits.

## Bias and variance

Bias is the error that comes from wrong assumptions in the model, such as assuming a straight line when the truth is curved. High bias leads to underfitting. Variance is the error that comes from sensitivity to the particular training set, so that a slightly different sample would produce a very different model. High variance leads to overfitting.

## The trade-off

Making a model more flexible usually lowers bias but raises variance, and making it simpler does the opposite. The expected test error is the sum of squared bias, variance and the irreducible noise in the data. The best model is not the one with the lowest training error but the one that balances bias and variance to give the lowest error on new data.

## How to tell which problem you have

Compare the training error with the validation error. If both are high and close together, the model is underfitting, so try more features or a more flexible model. If the training error is low but the validation error is much higher, the model is overfitting, so try more data, a simpler model or regularisation.
