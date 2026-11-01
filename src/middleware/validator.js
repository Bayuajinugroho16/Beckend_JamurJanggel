const { apiError } = require('../utils/helpers');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { value, error } = schema.validate(req[source], { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
      const errors = error.details.map((detail) => ({ field: detail.path.join('.'), message: detail.message }));
      return apiError(res, 'Validation failed', 422, errors);
    }
    req[source] = value;
    next();
  };
}

module.exports = { validate };
