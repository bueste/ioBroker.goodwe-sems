import iobrokerConfig from "@iobroker/eslint-config";

export default [
    ...iobrokerConfig,
    {
        rules: {
            // this project is plain, well-commented JS - the code comments carry the
            // explanation, repeating it as a one-line JSDoc description per @param
            // would just be noise. Types/@param names are still enforced.
            "jsdoc/require-jsdoc": "off",
            "jsdoc/require-param-description": "off",
            "jsdoc/require-returns-description": "off",
        },
    },
    {
        ignores: ["admin/build/", "admin/words.js", "test/**/*.js"],
    },
];
