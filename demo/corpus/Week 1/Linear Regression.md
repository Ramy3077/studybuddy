---
source: StudyBuddy demo corpus (original content)
topic: linear regression
---
# Linear Regression

## What problem it solves

Linear regression predicts a continuous number from one or more input features. Typical examples are predicting a house price from its floor area, or a student's exam mark from the hours they revised. The output is a real value, not a category, which is what separates regression from classification.

## The model

The model assumes the target is roughly a weighted sum of the inputs plus a constant. With one feature this is a straight line, $\hat{y} = w x + b$, where $w$ is the slope and $b$ is the intercept. With many features the prediction is the dot product of a weight vector with the feature vector, plus the bias term.

Each weight says how much the prediction changes when that feature increases by one unit and every other feature is held fixed. A positive weight pushes the prediction up and a negative weight pushes it down. The intercept is the prediction when every feature is zero.

## Fitting the model

Training means choosing the weights and the intercept so that predictions are close to the true targets on the training data. Closeness is measured by a loss function, most often the mean squared error. The fitted line is the one that makes the total squared vertical distance from the points to the line as small as possible.

## Residuals

A residual is the difference between the true target and the model's prediction for one example. Plotting residuals against the predictions is a quick health check. If the residuals look like random noise around zero, a linear model is a reasonable fit. If they curve or fan out, the relationship is probably not linear, or the noise is not constant across the range.

## Assumptions worth remembering

Linear regression works best when the relationship between features and target is close to linear, the errors are independent of each other, and the spread of the errors is roughly the same everywhere. It is sensitive to outliers, because squaring a large residual makes it dominate the loss. Strongly correlated features make individual weights unstable and hard to interpret, even when the predictions are still good.
