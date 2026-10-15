---
source: StudyBuddy demo corpus (original content)
topic: regularisation and cross-validation
---
# Regularisation and Validation

## What regularisation does

Regularisation reduces overfitting by adding a penalty on large weights to the loss function. The model now has to trade off fitting the training data against keeping its weights small. A strength parameter, often written as lambda, controls how heavily the penalty counts. A lambda of zero gives back the unregularised model, and a very large lambda pushes every weight towards zero and causes underfitting.

## Ridge regression (L2)

Ridge regression adds the sum of the squared weights to the loss. It shrinks all weights smoothly towards zero but rarely makes any of them exactly zero. Ridge is a good default when many features each contribute a little, and it also stabilises the weights when features are strongly correlated.

## Lasso regression (L1)

Lasso regression adds the sum of the absolute values of the weights instead. Its penalty can drive some weights to exactly zero, which removes those features from the model entirely. This makes lasso useful for feature selection when you suspect only a few features really matter.

## Validation sets

Hyperparameters such as lambda or the polynomial degree must not be tuned on the test set, or the test score stops being an honest estimate. Instead, split off a validation set from the training data, try several hyperparameter values, and pick the one with the lowest validation error. Only after that choice is final should you measure performance on the test set, once.

## k-fold cross-validation

With small datasets a single validation split wastes data and gives a noisy estimate. In k-fold cross-validation the training data is divided into k equal parts. The model is trained k times, each time holding out a different part for validation and training on the rest. The k validation scores are averaged to give a more reliable estimate, and five or ten folds are common choices.
