import iobrokerConfig from "@iobroker/eslint-config";

export default [
    ...iobrokerConfig,
    {
        rules: {
            // this project is plain, well-commented JS - keep it pragmatic
            "jsdoc/require-jsdoc": "off",
        },
    },
    {
        ignores: ["admin/build/", "admin/words.js", "test/**/*.js"],
    },
];
